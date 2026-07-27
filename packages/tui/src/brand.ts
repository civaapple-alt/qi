export function renderQiMark(width: number): string[] {
  if (width < 44) return ["栖 · QI", "evidence-first local agent"];
  return [
    "       ▄▄",
    "    ▄████▄",
    "   ██ ▄▄ ██",
    "    ▀█▄▄█▀",
    "══════╪══════",
    "   栖 · QI",
    "evidence-first local agent",
  ];
}
