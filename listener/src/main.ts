#!/usr/bin/env bun
import { realActions } from "./actions";
import { loadListenerConfig } from "./config";
import { createListener } from "./server";

const cfg = loadListenerConfig();
Bun.serve({ hostname: cfg.host, port: cfg.port, fetch: createListener(cfg, realActions(undefined, undefined, { dashboardUrl: cfg.dashboardUrl })).fetch });
console.log(`devbox-listener listening on ${cfg.host}:${cfg.port}`);
