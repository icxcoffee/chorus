export interface CustomUiLike {
  custom?: <T>(
    factory: (
      tui: { requestRender?: () => void },
      theme: ThemeLike,
      keybindings: unknown,
      done: (result: T) => void
    ) => TuiComponent
  ) => Promise<T>;
}

export interface ThemeLike {
  fg?: (color: string, text: string) => string;
  bold?: (text: string) => string;
}

export interface TuiComponent {
  render(width: number): string[];
  handleInput(data: unknown): void;
  invalidate?: () => void;
}

export interface TuiComponentTools<T> {
  theme: ThemeLike;
  keybindings: unknown;
  done: (result: T) => void;
  refresh: () => void;
  color: (name: string, text: string) => string;
  bold: (text: string) => string;
}

export function runCustomComponent<T>(
  ui: CustomUiLike,
  build: (tools: TuiComponentTools<T>) => TuiComponent
): Promise<T> | null {
  if (!ui.custom) return null;
  return ui.custom<T>((tui, theme, keybindings, done) => {
    const color = (name: string, text: string) => theme.fg?.(name, text) ?? text;
    const bold = (text: string) => theme.bold?.(text) ?? text;
    return build({
      theme,
      keybindings,
      done,
      refresh: () => tui.requestRender?.(),
      color,
      bold
    });
  });
}
