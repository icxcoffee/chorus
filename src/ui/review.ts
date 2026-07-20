import type { ReviewInputKind, ReviewLanguage, ReviewProfile, ReviewScopeRequest } from "../review/contracts.js";
import type { ReviewWorkflow } from "../workflows/contracts.js";
import type { ReviewRenderer } from "../renderers/registry.js";
import type { ModelInfo, ModelRef } from "../types.js";
import { modelRefToPiArg } from "../utils/models.js";
import { applyReviewProfile } from "../review/profiles.js";
import { runCustomComponent, type CustomUiLike } from "./component.js";
import { matchesUiCancel, matchesUiKeybinding, parseUiKey } from "./keys.js";
import { truncateToWidth } from "./width.js";

export interface ReviewComposerSettings {
    workflow: string;
    profile: ReviewProfile;
    scope: ReviewScopeRequest;
    renderer: string;
    language?: ReviewLanguage;
    roleModels?: Record<string, ModelRef>;
}

interface ModelPickerState {
    roleId: string;
    query: string;
    cursor: number;
}

interface ReviewModelOption {
    id: string;
    label: string;
    searchText: string;
}

export function describeReviewSettings(settings: ReviewComposerSettings): string[] {
    const scopeDetail = settings.scope.kind === "diff"
        ? `${settings.scope.kind}:${settings.scope.selection ?? "working"}`
        : settings.scope.paths?.length
            ? `${settings.scope.kind}:${settings.scope.paths.join(",")}`
            : settings.scope.kind;
    return [
        `Workflow: ${settings.workflow} | Profile: ${settings.profile}`,
        `Scope: ${scopeDetail} | Output: ${settings.renderer}`,
        `Language: ${settings.language ?? "zh-CN"}`,
        ...(Object.keys(settings.roleModels ?? {}).length ? [`Models: ${Object.keys(settings.roleModels ?? {}).length} saved preset default(s)`] : []),
    ];
}

export async function configureReviewSettings(args: {
    ui: CustomUiLike;
    workflows: ReviewWorkflow[];
    renderers: ReviewRenderer[];
    models: ModelInfo[];
    initial: ReviewComposerSettings;
}): Promise<ReviewComposerSettings | null> {
    if (!args.ui.custom) return null;
    return runCustomComponent<ReviewComposerSettings | null>(args.ui, ({ theme, keybindings, done, refresh }) => {
        let current = { ...structuredClone(args.initial), language: args.initial.language ?? "zh-CN" };
        let cursor = 0;
        let editingPaths = false;
        let modelPicker: ModelPickerState | null = null;
        let pathText = current.scope.paths?.join(", ") ?? "";
        const workflowIds = args.workflows.map((workflow) => workflow.definition.id);
        const rendererIds = args.renderers.map((renderer) => renderer.id);
        const modelIds = ["auto", ...args.models.map((model) => `${model.provider}/${model.modelId}`)];
        const modelOptions: ReviewModelOption[] = [
            { id: "auto", label: "Auto (workflow policy)", searchText: "auto automatic workflow policy default" },
            ...args.models.map((model) => ({
                id: `${model.provider}/${model.modelId}`,
                label: `${model.modelId} [${model.provider}]`,
                searchText: `${model.provider}/${model.modelId} ${model.provider} ${model.modelId} ${model.name ?? ""}`,
            })),
        ];
        const activeWorkflow = () => args.workflows.find((workflow) => workflow.definition.id === current.workflow) ?? args.workflows[0];
        const allowedScopes = () => activeWorkflow()?.definition.allowedScopeKinds ?? ["repository"];
        const activeRoles = () => activeWorkflow() ? applyReviewProfile(activeWorkflow()!.definition, current.profile).roles : [];
        const rows = () => [
            { id: "workflow", label: "Workflow", value: current.workflow },
            { id: "profile", label: "Profile", value: current.profile },
            ...activeRoles().map((assignment) => ({ id: `model:${assignment.roleId}`, label: `Model ${assignment.roleId}`, value: current.roleModels?.[assignment.roleId] ? modelRefToPiArg(current.roleModels[assignment.roleId]!) : "Auto" })),
            { id: "scope", label: "Scope", value: current.scope.kind },
            ...(current.scope.kind === "diff" ? [{ id: "selection", label: "Diff", value: current.scope.selection ?? "working" }] : []),
            ...(["files", "document"].includes(current.scope.kind) ? [{ id: "paths", label: "Paths", value: pathText || (current.scope.kind === "files" ? "required" : "all documents") }] : []),
            { id: "renderer", label: "Output", value: current.renderer },
            { id: "language", label: "Language", value: current.language },
            { id: "save", label: "Apply", value: "save model defaults and return" },
        ];
        const cycle = (values: readonly string[], value: string, direction: number): string => {
            const index = Math.max(0, values.indexOf(value));
            return values[(index + direction + values.length) % values.length] ?? value;
        };
        const selectedModelId = (roleId: string): string => current.roleModels?.[roleId]
            ? modelRefToPiArg(current.roleModels[roleId]!)
            : "auto";
        const setRoleModel = (roleId: string, selected: string): void => {
            const roleModels = { ...(current.roleModels ?? {}) };
            if (selected === "auto") delete roleModels[roleId];
            else {
                const slash = selected.indexOf("/");
                roleModels[roleId] = { provider: selected.slice(0, slash), modelId: selected.slice(slash + 1) };
            }
            const { roleModels: _previousRoleModels, ...withoutRoleModels } = current;
            current = { ...withoutRoleModels, ...(Object.keys(roleModels).length ? { roleModels } : {}) };
        };
        const visibleModelOptions = (): ReviewModelOption[] => {
            if (!modelPicker) return [];
            const terms = modelPicker.query.trim().toLowerCase().split(/\s+/).filter(Boolean);
            if (!terms.length) return modelOptions;
            return modelOptions.filter((option) => {
                const searchable = `${option.label} ${option.searchText}`.toLowerCase();
                return terms.every((term) => searchable.includes(term));
            });
        };
        const openModelPicker = (roleId: string, query = ""): void => {
            const currentId = selectedModelId(roleId);
            const currentIndex = query ? 0 : Math.max(0, modelOptions.findIndex((option) => option.id === currentId));
            modelPicker = { roleId, query, cursor: currentIndex };
        };
        const updateCurrentRow = (direction: number): void => {
            const row = rows()[cursor];
            if (!row) return;
            if (row.id === "workflow") {
                current.workflow = cycle(workflowIds, current.workflow, direction);
                const scopes = allowedScopes();
                if (!scopes.includes(current.scope.kind)) current.scope = { kind: scopes[0] ?? "repository", ...(current.scope.root ? { root: current.scope.root } : {}) };
            } else if (row.id === "profile") current.profile = current.profile === "quick" ? "deep" : "quick";
            else if (row.id.startsWith("model:")) {
                const roleId = row.id.slice("model:".length);
                setRoleModel(roleId, cycle(modelIds, selectedModelId(roleId), direction));
            }
            else if (row.id === "scope") {
                const kind = cycle(allowedScopes(), current.scope.kind, direction) as ReviewInputKind;
                current.scope = { kind, ...(current.scope.root ? { root: current.scope.root } : {}), ...(kind === "diff" ? { selection: "working" as const } : {}) };
                pathText = "";
            } else if (row.id === "selection") {
                const selection = cycle(["working", "staged"], current.scope.selection ?? "working", direction) as "working" | "staged";
                current.scope = { ...current.scope, selection };
            } else if (row.id === "renderer") current.renderer = cycle(rendererIds, current.renderer, direction);
            else if (row.id === "language") current.language = current.language === "zh-CN" ? "en" : "zh-CN";
        };
        const applyPaths = (): void => {
            const paths = pathText.split(",").map((path) => path.trim()).filter(Boolean);
            const { paths: _previousPaths, ...scopeWithoutPaths } = current.scope;
            current.scope = { ...scopeWithoutPaths, ...(paths.length ? { paths } : {}) };
        };
        return {
            render(width) {
                const safeWidth = Math.max(42, width);
                const color = (name: string, text: string) => theme.fg?.(name, text) ?? text;
                const bold = (text: string) => theme.bold?.(text) ?? text;
                if (modelPicker) {
                    const visible = visibleModelOptions();
                    modelPicker.cursor = Math.min(modelPicker.cursor, Math.max(0, visible.length - 1));
                    const currentId = selectedModelId(modelPicker.roleId);
                    const maxVisible = 12;
                    const start = Math.max(0, Math.min(modelPicker.cursor - Math.floor(maxVisible / 2), Math.max(0, visible.length - maxVisible)));
                    const end = Math.min(visible.length, start + maxVisible);
                    const lines = [
                        color("accent", "-".repeat(safeWidth)),
                        ` ${color("accent", bold(`Choose Model: ${modelPicker.roleId}`))}`,
                        ` Search: ${modelPicker.query || "-"}`,
                        ` Current: ${currentId === "auto" ? "Auto" : currentId} | ${visible.length}/${modelOptions.length} shown`,
                        "",
                        ...(visible.length
                            ? visible.slice(start, end).map((option, offset) => {
                                const index = start + offset;
                                const pointer = index === modelPicker!.cursor ? color("accent", "> ") : "  ";
                                const currentTag = option.id === currentId ? color("success", " [current]") : "";
                                const label = index === modelPicker!.cursor ? color("accent", option.label) : option.label;
                                return `${pointer}${label}${currentTag}`;
                            })
                            : [color("warning", " No matching models.")]),
                        ...(visible.length > maxVisible ? [` ${start + 1}-${end} of ${visible.length}`] : []),
                        "",
                        " Type to search - up/down move - enter select - backspace delete - esc back",
                        color("accent", "-".repeat(safeWidth)),
                    ];
                    return lines.map((line) => truncateToWidth(line, safeWidth));
                }
                const items = rows();
                cursor = Math.min(cursor, items.length - 1);
                const invalid = current.scope.kind === "files" && pathText.split(",").every((path) => !path.trim());
                const lines = [
                    color("accent", "-".repeat(safeWidth)),
                    ` ${color("accent", bold("Chorus Review Settings"))}`,
                    ` ${activeWorkflow()?.definition.objective ?? ""}`,
                    "",
                    ...items.map((row, index) => {
                        const pointer = index === cursor ? color("accent", "> ") : "  ";
                        const value = row.id === "paths" && editingPaths ? `${pathText}_` : row.value;
                        const line = `${row.label}: ${value}`;
                        return `${pointer}${index === cursor ? color("accent", line) : line}`;
                    }),
                    ...(invalid ? ["", color("warning", " Files scope requires comma-separated paths.")] : []),
                    "",
                    editingPaths
                        ? " Type paths separated by commas - enter accept - esc discard edit"
                        : items[cursor]?.id.startsWith("model:")
                            ? " enter/type search models - left/right quick change - up/down move - esc keep previous"
                            : " up/down move - left/right change - enter edit/apply - esc keep previous",
                    color("accent", "-".repeat(safeWidth)),
                ];
                return lines.map((line) => truncateToWidth(line, safeWidth));
            },
            handleInput(data) {
                const key = parseUiKey(data);
                if (modelPicker) {
                    const visible = visibleModelOptions();
                    if (matchesUiCancel(keybindings, data, key)) modelPicker = null;
                    else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") {
                        if (visible.length) modelPicker.cursor = modelPicker.cursor === 0 ? visible.length - 1 : modelPicker.cursor - 1;
                    } else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down" || key.key === "tab") {
                        if (visible.length) modelPicker.cursor = modelPicker.cursor === visible.length - 1 ? 0 : modelPicker.cursor + 1;
                    } else if (matchesUiKeybinding(keybindings, data, "tui.select.confirm") || key.key === "enter") {
                        const selected = visible[modelPicker.cursor];
                        if (selected) {
                            setRoleModel(modelPicker.roleId, selected.id);
                            modelPicker = null;
                        }
                    } else if (key.key === "backspace") {
                        modelPicker.query = modelPicker.query.slice(0, -1);
                        modelPicker.cursor = 0;
                    } else if (key.key === "text" || key.key === "space") {
                        modelPicker.query += key.text ?? "";
                        modelPicker.cursor = 0;
                    }
                    refresh();
                    return;
                }
                if (editingPaths) {
                    if (matchesUiCancel(keybindings, data, key)) {
                        pathText = current.scope.paths?.join(", ") ?? "";
                        editingPaths = false;
                    } else if (key.key === "enter") {
                        applyPaths();
                        editingPaths = false;
                    } else if (key.key === "backspace") pathText = pathText.slice(0, -1);
                    else if (key.key === "text" || key.key === "space") pathText += key.text ?? "";
                    refresh();
                    return;
                }
                const items = rows();
                if (matchesUiCancel(keybindings, data, key)) done(null);
                else if (matchesUiKeybinding(keybindings, data, "tui.select.up") || key.key === "up") { cursor = cursor === 0 ? items.length - 1 : cursor - 1; refresh(); }
                else if (matchesUiKeybinding(keybindings, data, "tui.select.down") || key.key === "down" || key.key === "tab") { cursor = cursor === items.length - 1 ? 0 : cursor + 1; refresh(); }
                else if (key.key === "left" || key.key === "right") { updateCurrentRow(key.key === "left" ? -1 : 1); refresh(); }
                else if (matchesUiKeybinding(keybindings, data, "tui.select.confirm") || key.key === "enter") {
                    const row = items[cursor];
                    if (row?.id === "paths") { editingPaths = true; refresh(); }
                    else if (row?.id.startsWith("model:")) { openModelPicker(row.id.slice("model:".length)); refresh(); }
                    else if (row?.id === "save") {
                        applyPaths();
                        if (current.scope.kind !== "files" || current.scope.paths?.length) done(current);
                    } else { updateCurrentRow(1); refresh(); }
                } else if (key.key === "text") {
                    const row = items[cursor];
                    if (row?.id.startsWith("model:")) {
                        openModelPicker(row.id.slice("model:".length), key.text === "/" ? "" : (key.text ?? ""));
                        refresh();
                    }
                }
            },
        };
    });
}
