import { createContext, useContext, useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

export type Theme = "dark" | "light" | "system";
const ThemeCtx = createContext<{ theme: Theme; setTheme: (t: Theme) => void }>({ theme: "system", setTheme: () => {} });

/** system → light → dark → system. The toggle used to cycle only dark↔light, which
 *  after the first click permanently discarded "follow the device" with no way back to it. */
export const nextTheme = (t: Theme): Theme => (t === "system" ? "light" : t === "light" ? "dark" : "system");

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [theme, setTheme] = useState<Theme>(() => (localStorage.getItem("devbox-theme") as Theme) || "system");
  useEffect(() => {
    const root = document.documentElement;
    const apply = (t: Theme) => {
      const dark = t === "dark" || (t === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches);
      root.classList.toggle("dark", dark);
    };
    apply(theme);
    localStorage.setItem("devbox-theme", theme);
    if (theme !== "system") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => apply("system");
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [theme]);
  return <ThemeCtx.Provider value={{ theme, setTheme }}>{children}</ThemeCtx.Provider>;
}

export const useTheme = () => useContext(ThemeCtx);

const LABEL: Record<Theme, string> = {
  system: "Theme: follow device",
  light: "Theme: light",
  dark: "Theme: dark",
};

export function ModeToggle() {
  const { theme, setTheme } = useTheme();
  const Icon = theme === "system" ? Monitor : theme === "light" ? Sun : Moon;
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={LABEL[theme]}
      title={LABEL[theme]}
      onClick={() => setTheme(nextTheme(theme))}
    >
      <Icon className="h-4 w-4" />
    </Button>
  );
}
