import type { Context } from "@plugim/core";
import { ArrowLeftIcon } from "lucide-react";
import { useEffect, useReducer, useSyncExternalStore } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Button } from "../components/ui/button";
import { Switch } from "../components/ui/switch";
import type { SettingsField, SettingsService, SettingsValue } from "./settings";
import type { ThemeService } from "./theme";
import type { UiService } from "./ui-types";

interface AppearanceItem {
    key: string;
    label: string;
    kind: "color" | "number";
    defaults: [string, string];
    min?: number;
    max?: number;
    step?: number;
    unit?: string;
    varName: string;
}

export const APPEARANCE_ITEMS: AppearanceItem[] = [
    {
        key: "primary",
        label: "主色",
        kind: "color",
        defaults: ["#1779e1", "#4392f7"],
        varName: "--primary",
    },
    {
        key: "background",
        label: "页面背景",
        kind: "color",
        defaults: ["#fcfaf6", "#130f0a"],
        varName: "--background",
    },
    {
        key: "card",
        label: "卡片背景",
        kind: "color",
        defaults: ["#fefdfc", "#1c1712"],
        varName: "--card",
    },
    {
        key: "chat_bg",
        label: "聊天背景",
        kind: "color",
        defaults: ["#f6f3ee", "#18140f"],
        varName: "--chat-bg",
    },
    {
        key: "border",
        label: "边框描边",
        kind: "color",
        defaults: ["#e5e3de", "#302a24"],
        varName: "--border",
    },
    {
        key: "muted",
        label: "次级底色",
        kind: "color",
        defaults: ["#f2f0ec", "#2b251f"],
        varName: "--muted",
    },
    {
        key: "accent_fg",
        label: "强调前景",
        kind: "color",
        defaults: ["#0048a1", "#a1c1e4"],
        varName: "--accent-foreground",
    },
    {
        key: "destructive",
        label: "危险色",
        kind: "color",
        defaults: ["#d53c3d", "#c13c3b"],
        varName: "--destructive",
    },
    {
        key: "radius",
        label: "组件圆角",
        kind: "number",
        defaults: ["0.75", "0.75"],
        min: 0,
        max: 1.5,
        step: 0.05,
        unit: "rem",
        varName: "--radius",
    },
];

const srgbToLinear = (v: number) =>
    v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;

const linearToSrgb8 = (u: number) => {
    const x =
        u <= 0.0031308
            ? 12.92 * u
            : 1.055 * Math.max(u, 0) ** (1 / 2.4) - 0.055;
    return Math.round(Math.min(1, Math.max(0, x)) * 255);
};

const oklabToCss = (L: number, a: number, b: number) => {
    const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
    const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
    const s_ = L - 0.0894841775 * a - 1.291485548 * b;
    const lp = l_ * l_ * l_;
    const mp = m_ * m_ * m_;
    const sp = s_ * s_ * s_;
    const r = 4.0767416621 * lp - 3.3077115913 * mp + 0.2309699292 * sp;
    const g = -1.2684380046 * lp + 2.6097574011 * mp - 0.3413193965 * sp;
    const bl = -0.0041960863 * lp - 0.7034186147 * mp + 1.707614701 * sp;
    return `#${[r, g, bl]
        .map((u) => linearToSrgb8(u).toString(16).padStart(2, "0"))
        .join("")}`;
};

const hexToOklchCss = (hex: string): string | null => {
    const m = /^#?([\da-f]{6})$/i.exec(hex.trim());
    if (!m) return null;
    const n = Number.parseInt(m[1], 16);
    const lr = srgbToLinear(((n >> 16) & 0xff) / 255);
    const lg = srgbToLinear(((n >> 8) & 0xff) / 255);
    const lb = srgbToLinear((n & 0xff) / 255);
    const l = Math.cbrt(
        0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb,
    );
    const mm = Math.cbrt(
        0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb,
    );
    const s = Math.cbrt(
        0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb,
    );
    const L = 0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s;
    const a = 1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s;
    const b = 0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s;
    const c = Math.sqrt(a * a + b * b);
    let h = (Math.atan2(b, a) * 180) / Math.PI;
    if (h < 0) h += 360;
    return `oklch(${L.toFixed(4)} ${c.toFixed(4)} ${h.toFixed(4)})`;
};

const oklchCssToHex = (l: number, c: number, hDeg: number): string => {
    const rad = (hDeg * Math.PI) / 180;
    return oklabToCss(l, c * Math.cos(rad), c * Math.sin(rad));
};

const readTokenHex = (name: string, fallback: string): string => {
    const raw = getComputedStyle(document.documentElement)
        .getPropertyValue(name)
        .trim();
    const m = /^oklch\(\s*([\d.]+)(%?)\s+([\d.]+)\s+([\d.]+)/.exec(raw);
    if (m) {
        const l = Number(m[1]) / (m[2] ? 100 : 1);
        return oklchCssToHex(l, Number(m[3]), Number(m[4]));
    }
    if (raw.startsWith("#")) return raw;
    return fallback;
};

export const appearanceSettingsFields = (): SettingsField[] => {
    const fields: SettingsField[] = [];
    for (const item of APPEARANCE_ITEMS) {
        if (item.kind === "color") {
            fields.push({
                key: item.key,
                label: item.label,
                kind: "color",
                default: item.defaults[0],
            });
            fields.push({
                key: `${item.key}_dark`,
                label: `${item.label}(深色)`,
                kind: "color",
                default: item.defaults[1],
            });
        } else {
            fields.push({
                key: item.key,
                label: item.label,
                kind: "number",
                default: Number(item.defaults[0]),
                min: item.min,
                max: item.max,
                step: item.step,
            });
        }
    }
    return fields;
};

const writtenVars = new Set<string>();

export const applyAppearance = (
    settings: SettingsService,
    theme: ThemeService,
) => {
    const root = document.documentElement;
    const dark = theme.mode() === "dark";
    const remove = (varName: string) => {
        if (writtenVars.has(varName)) {
            root.style.removeProperty(varName);
            writtenVars.delete(varName);
        }
    };
    for (const item of APPEARANCE_ITEMS) {
        const currentKey = dark ? `${item.key}_dark` : item.key;
        const otherKey = dark ? item.key : `${item.key}_dark`;
        const currentValue = String(
            settings.get("views", currentKey),
        ).toLowerCase();
        const otherValue = String(
            settings.get("views", otherKey),
        ).toLowerCase();
        const candidate =
            currentValue !== String(item.defaults[dark ? 1 : 0]).toLowerCase()
                ? currentValue
                : otherValue !==
                    String(item.defaults[dark ? 0 : 1]).toLowerCase()
                  ? otherValue
                  : "";
        if (!candidate) {
            remove(item.varName);
            continue;
        }
        let css = candidate;
        if (item.kind === "color") {
            const converted = hexToOklchCss(candidate);
            if (!converted) {
                remove(item.varName);
                continue;
            }
            css = converted;
        } else {
            css = `${Number(candidate)}${item.unit ?? ""}`;
        }
        root.style.setProperty(item.varName, css);
        writtenVars.add(item.varName);
    }
};

const useBump = () => useReducer((n: number) => n + 1, 0)[1];

const BackButton = () => {
    const navigate = useNavigate();
    return (
        <Button
            variant="ghost"
            size="icon-sm"
            title="返回"
            onClick={() => void navigate(-1)}
        >
            <ArrowLeftIcon />
        </Button>
    );
};

const useThemeDark = (theme: ThemeService) =>
    useSyncExternalStore(
        (cb) => theme.onChange(cb),
        () => theme.mode() === "dark",
    );

const ColorRow = ({
    item,
    settings,
    theme,
    rowClass,
}: {
    item: AppearanceItem;
    settings: SettingsService;
    theme: ThemeService;
    rowClass: string;
}) => {
    const dark = useThemeDark(theme);
    const key = dark ? `${item.key}_dark` : item.key;
    const fallback = item.defaults[dark ? 1 : 0];
    const stored = String(settings.get("views", key));
    const isDefault = stored.toLowerCase() === fallback.toLowerCase();
    const swatch = isDefault ? readTokenHex(item.varName, fallback) : stored;
    return (
        <div className={rowClass}>
            <div className="min-w-0 flex-1">
                <p className="text-sm">{item.label}</p>
                <p className="text-xs text-muted-foreground">
                    {dark ? "正在修改深色模式" : "正在修改浅色模式"}
                </p>
            </div>
            <span className="text-xs tabular-nums text-muted-foreground">
                {swatch}
            </span>
            <input
                type="color"
                value={/^#[0-9a-f]{6}$/i.test(swatch) ? swatch : "#888888"}
                onChange={(e) => settings.set("views", key, e.target.value)}
                className="size-9 cursor-pointer rounded-lg border border-border bg-transparent p-1"
            />
            <Button
                size="sm"
                variant="ghost"
                disabled={isDefault}
                onClick={() => settings.reset("views", key)}
            >
                还原
            </Button>
        </div>
    );
};

const RadiusRow = ({
    item,
    settings,
    rowClass,
}: {
    item: AppearanceItem;
    settings: SettingsService;
    rowClass: string;
}) => {
    const value = Number(settings.get("views", item.key));
    const fallback = Number(item.defaults[0]);
    return (
        <div className={rowClass}>
            <div className="min-w-0 flex-1">
                <p className="text-sm">{item.label}</p>
                <p className="text-xs text-muted-foreground">
                    全部组件圆角，0 为直角
                </p>
            </div>
            <input
                type="range"
                min={item.min ?? 0}
                max={item.max ?? 2}
                step={item.step ?? 0.05}
                value={Number.isNaN(value) ? fallback : value}
                onChange={(e) => {
                    const next = Number(e.target.value);
                    settings.set("views", item.key, next);
                    settings.set("views", `${item.key}_dark`, next);
                }}
                className="w-40 accent-primary"
            />
            <span className="w-14 text-right text-xs tabular-nums text-muted-foreground">
                {value}
                {item.unit}
            </span>
            <Button
                size="sm"
                variant="ghost"
                disabled={value === fallback}
                onClick={() => settings.reset("views", item.key)}
            >
                还原
            </Button>
        </div>
    );
};

const GenericRow = ({
    plugin,
    field,
    settings,
    rowClass,
}: {
    plugin: string;
    field: SettingsField;
    settings: SettingsService;
    rowClass: string;
}) => {
    const value: SettingsValue = settings.get(plugin, field.key);
    if (field.kind === "boolean") {
        return (
            <div className={rowClass}>
                <p className="min-w-0 flex-1 text-sm">{field.label}</p>
                <Switch
                    checked={Boolean(value)}
                    onToggle={() => settings.set(plugin, field.key, !value)}
                />
            </div>
        );
    }
    if (field.kind === "select" && field.options) {
        return (
            <div className={rowClass}>
                <p className="min-w-0 flex-1 text-sm">{field.label}</p>
                <select
                    value={String(value)}
                    onChange={(e) =>
                        settings.set(plugin, field.key, e.target.value)
                    }
                    className="rounded-lg border border-border bg-card px-2 py-1 text-sm"
                >
                    {field.options.map((option) => (
                        <option key={option.value} value={option.value}>
                            {option.label}
                        </option>
                    ))}
                </select>
            </div>
        );
    }
    if (field.kind === "number") {
        return (
            <div className={rowClass}>
                <p className="min-w-0 flex-1 text-sm">{field.label}</p>
                <input
                    type="number"
                    value={Number(value)}
                    min={field.min}
                    max={field.max}
                    step={field.step}
                    onChange={(e) =>
                        settings.set(plugin, field.key, Number(e.target.value))
                    }
                    className="w-24 rounded-lg border border-border bg-card px-2 py-1 text-sm"
                />
            </div>
        );
    }
    return (
        <div className={rowClass}>
            <p className="min-w-0 flex-1 text-sm">{field.label}</p>
            <span className="text-xs text-muted-foreground">
                {String(value)}
            </span>
        </div>
    );
};

export const uiSettingsSetup = async (ctx: Context) => {
    const ui = ctx.get<UiService>("ui");
    const settings = ctx.get<SettingsService>("settings");
    const theme = ctx.get<ThemeService>("theme");

    settings.define("views", "外观", appearanceSettingsFields());
    applyAppearance(settings, theme);
    const offSettings = settings.onChange("*", () =>
        applyAppearance(settings, theme),
    );
    const offTheme = theme.onChange(() => applyAppearance(settings, theme));

    const SettingsPage = () => {
        const bump = useBump();
        useEffect(() => {
            const offSettings = settings.onChange("*", bump);
            const offTheme = theme.onChange(bump);
            return () => {
                offSettings();
                offTheme();
            };
        }, [bump]);
        const rowClass =
            "flex items-center gap-3 border-b border-border px-4 py-3 last:border-b-0";
        const name = useParams().plugin ?? "";
        const group = settings.groups().find((item) => item.plugin === name);
        if (!group) {
            return (
                <div className="flex h-full flex-col">
                    <div className="flex h-12 min-h-12 shrink-0 items-center gap-1 border-b border-border px-3">
                        <BackButton />
                        <p className="text-sm font-semibold">插件设置</p>
                    </div>
                    <div className="flex min-h-0 flex-1 items-center justify-center text-sm text-muted-foreground">
                        该插件没有可配置的设置项
                    </div>
                </div>
            );
        }
        const isViews = group.plugin === "views";
        return (
            <div className="flex h-full flex-col">
                <div className="flex h-12 min-h-12 shrink-0 items-center gap-1 border-b border-border px-3">
                    <BackButton />
                    <p className="text-sm font-semibold">{group.title}设置</p>
                    <span className="text-xs text-muted-foreground">
                        插件 {group.plugin}
                    </span>
                    <Button
                        size="sm"
                        variant="ghost"
                        className="ml-auto"
                        onClick={() => settings.resetPlugin(group.plugin)}
                    >
                        全部还原
                    </Button>
                </div>
                <div className="min-h-0 flex-1 overflow-y-auto p-4">
                    <section className="mx-auto w-full max-w-xl overflow-hidden rounded-xl border border-border bg-card">
                        {isViews
                            ? APPEARANCE_ITEMS.map((item) =>
                                  item.kind === "color" ? (
                                      <ColorRow
                                          key={item.key}
                                          item={item}
                                          theme={theme}
                                          settings={settings}
                                          rowClass={rowClass}
                                      />
                                  ) : (
                                      <RadiusRow
                                          key={item.key}
                                          item={item}
                                          settings={settings}
                                          rowClass={rowClass}
                                      />
                                  ),
                              )
                            : group.fields.map((field) => (
                                  <GenericRow
                                      key={`${group.plugin}:${field.key}`}
                                      plugin={group.plugin}
                                      field={field}
                                      settings={settings}
                                      rowClass={rowClass}
                                  />
                              ))}
                    </section>
                </div>
            </div>
        );
    };

    const unregisterRoute = ui.registerRoute("/settings/:plugin", SettingsPage);

    return () => {
        offSettings();
        offTheme();
        unregisterRoute();
    };
};
