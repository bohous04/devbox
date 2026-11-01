import { expect, test } from "bun:test";
import { parseKumaMetrics } from "../src/kuma";

// A shortened but verbatim excerpt of a real kuma.example.com/metrics response.
const SAMPLE = `# HELP monitor_cert_days_remaining The number of days remaining until the certificate expires
# TYPE monitor_cert_days_remaining gauge
monitor_cert_days_remaining{INFRA="",monitor_id="8",monitor_name="Acme Shop",monitor_type="http",monitor_url="https://shop.example.com/",monitor_hostname="null",monitor_port="null"} 84

# HELP monitor_uptime_ratio Uptime ratio
# TYPE monitor_uptime_ratio gauge
monitor_uptime_ratio{monitor_id="1",monitor_name="INFRA",monitor_type="group",monitor_url="https://",monitor_hostname="null",monitor_port="null",window="1d"} 1
monitor_uptime_ratio{INFRA="",monitor_id="8",monitor_name="Acme Shop",monitor_type="http",monitor_url="https://shop.example.com/",monitor_hostname="null",monitor_port="null",window="1d"} 1
monitor_uptime_ratio{INFRA="",monitor_id="8",monitor_name="Acme Shop",monitor_type="http",monitor_url="https://shop.example.com/",monitor_hostname="null",monitor_port="null",window="30d"} 0.9996455660310484
monitor_uptime_ratio{INFRA="",monitor_id="8",monitor_name="Acme Shop",monitor_type="http",monitor_url="https://shop.example.com/",monitor_hostname="null",monitor_port="null",window="365d"} 0.9990320666937271
monitor_uptime_ratio{Acme="",monitor_id="6",monitor_name="Acme SSH",monitor_type="port",monitor_url="https://",monitor_hostname="192.0.2.14",monitor_port="2222",window="30d"} 0.9999054909743881

# TYPE monitor_response_time_seconds gauge
monitor_response_time_seconds{INFRA="",monitor_id="8",monitor_name="Acme Shop",monitor_type="http",monitor_url="https://shop.example.com/",monitor_hostname="null",monitor_port="null",window="1d"} 0.1234
monitor_response_time_seconds{INFRA="",monitor_id="8",monitor_name="Acme Shop",monitor_type="http",monitor_url="https://shop.example.com/",monitor_hostname="null",monitor_port="null",window="30d"} 0.9

# TYPE monitor_status gauge
monitor_status{monitor_id="1",monitor_name="INFRA",monitor_type="group",monitor_url="https://",monitor_hostname="null",monitor_port="null"} 1
monitor_status{INFRA="",monitor_id="8",monitor_name="Acme Shop",monitor_type="http",monitor_url="https://shop.example.com/",monitor_hostname="null",monitor_port="null"} 1
monitor_status{Acme="",monitor_id="6",monitor_name="Acme SSH",monitor_type="port",monitor_url="https://",monitor_hostname="192.0.2.14",monitor_port="2222"} 0
monitor_status{INFRA="",monitor_id="2",monitor_name="INFRA Borg backup heartbeat",monitor_type="push",monitor_url="https://",monitor_hostname="null",monitor_port="null"} 1

# TYPE nodejs_active_handles gauge
nodejs_active_handles{type="Socket"} 3
app_version{version="2.0.0",major="2",minor="0",patch="0"} 1
`;

test("parseKumaMetrics folds metrics into one record per monitor", () => {
  const monitors = parseKumaMetrics(SAMPLE);
  const ad = monitors.find((m) => m.id === "8")!;
  expect(ad.name).toBe("Acme Shop");
  expect(ad.type).toBe("http");
  expect(ad.url).toBe("https://shop.example.com/");
  expect(ad.up).toBe(true);
  expect(ad.uptime1d).toBe(1);
  expect(ad.uptime30d).toBeCloseTo(0.99964, 4);
  expect(ad.uptime365d).toBeCloseTo(0.99903, 4);
  expect(ad.certDaysLeft).toBe(84);
});

test("response time comes from the 1d window and is converted to milliseconds", () => {
  const ad = parseKumaMetrics(SAMPLE).find((m) => m.id === "8")!;
  expect(ad.responseMs).toBe(123); // 0.1234 s from the 1d window, not 0.9 s from 30d
});

test("groups do not make it into the list", () => {
  const monitors = parseKumaMetrics(SAMPLE);
  expect(monitors.some((m) => m.type === "group")).toBe(false);
  expect(monitors.some((m) => m.id === "1")).toBe(false);
});

test("non-monitor metrics are ignored", () => {
  const monitors = parseKumaMetrics(SAMPLE);
  expect(monitors.map((m) => m.id).sort()).toEqual(["2", "6", "8"]);
});

test("a Kuma tag is recognised by a label without a value", () => {
  const monitors = parseKumaMetrics(SAMPLE);
  expect(monitors.find((m) => m.id === "8")!.tag).toBe("INFRA");
  expect(monitors.find((m) => m.id === "6")!.tag).toBe("Acme");
});

test("failing monitors go to the top", () => {
  const monitors = parseKumaMetrics(SAMPLE);
  expect(monitors[0].id).toBe("6"); // the only one with monitor_status 0
  expect(monitors[0].up).toBe(false);
});

test("null in url and hostname becomes null, not a string", () => {
  const push = parseKumaMetrics(SAMPLE).find((m) => m.id === "2")!;
  expect(push.url).toBeNull();
  expect(push.hostname).toBeNull();
});

test("an unmeasured value (Nan) does not end up as NaN in the data", () => {
  const monitors = parseKumaMetrics(`monitor_status{monitor_id="9",monitor_name="X",monitor_type="http"} 1
monitor_response_time{monitor_id="9",monitor_name="X",monitor_type="http"} Nan
monitor_cert_days_remaining{monitor_id="9",monitor_name="X",monitor_type="http"} Nan
`);
  expect(monitors[0].responseMs).toBeNull();
  expect(monitors[0].certDaysLeft).toBeNull();
});

test("response time -1 (push monitor) is not -1 ms but unmeasured", () => {
  // Kuma reports -1 where it has no response time — otherwise the page would show "−1 ms".
  const m = parseKumaMetrics(`monitor_status{monitor_id="2",monitor_name="Heartbeat",monitor_type="push"} 1
monitor_response_time{monitor_id="2",monitor_name="Heartbeat",monitor_type="push"} -1
`)[0];
  expect(m.responseMs).toBeNull();
});

test("empty input returns an empty list, not an exception", () => {
  expect(parseKumaMetrics("")).toEqual([]);
  expect(parseKumaMetrics("# just a comment\n")).toEqual([]);
});
