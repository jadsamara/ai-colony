export interface RetentionItem {
  itemId: string;
  split: string;
  category: "record-extraction" | "exact-copy";
  prompt: string;
  expected: number | string;
  scoreMode: "integer" | "exact";
}

const NAMES = ["Ada", "Noor", "Kenji", "Leila", "Omar", "Priya", "Sofia", "Jonah", "Mina", "Hugo", "Imani", "Elena", "Ravi", "Chloe", "Yusuf", "Greta"];
const CITIES = ["London", "Tunis", "Osaka", "Quito", "Accra", "Lisbon", "Riga", "Dakar"];

export function retentionItems(split: "retention-dev" | "retention-confirm"): RetentionItem[] {
  const start = split === "retention-dev" ? 0 : 16;
  const items: RetentionItem[] = [];
  for (let offset = 0; offset < 16; offset += 1) {
    const index = start + offset;
    const year = 1810 + index * 7;
    const name = NAMES[index % NAMES.length];
    const city = CITIES[index % CITIES.length];
    items.push({
      itemId: `${split}-extract-${index}`,
      split,
      category: "record-extraction",
      prompt: `Extract the year from the record. Reply with the integer only.\nRecord: name=${name}|year=${year}|city=${city}`,
      expected: year,
      scoreMode: "integer",
    });
    const token = `QX${String(index).padStart(2, "0")}`;
    items.push({
      itemId: `${split}-copy-${index}`,
      split,
      category: "exact-copy",
      prompt: `Reply with exactly this token and nothing else: ${token}`,
      expected: token,
      scoreMode: "exact",
    });
  }
  return items;
}

export function expectedFromRetentionPrompt(category: RetentionItem["category"], prompt: string): number | string {
  if (category === "record-extraction") {
    const match = prompt.match(/year=(\d+)/);
    if (match?.[1] === undefined) {
      throw new Error("retention record has no year");
    }
    return Number(match[1]);
  }
  const marker = "Reply with exactly this token and nothing else: ";
  const index = prompt.lastIndexOf(marker);
  if (index < 0) {
    throw new Error("retention copy prompt is missing its token");
  }
  return prompt.slice(index + marker.length).trim();
}
