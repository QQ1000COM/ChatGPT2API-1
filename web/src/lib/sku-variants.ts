export type SkuVariant = {
  label: string;
  raw: string;
  color?: string;
  specs: string[];
  dimensions: Array<{ name: string; value: string }>;
};

const MAX_SKU_VARIANTS = 40;
const COLOR_KEYS = ["颜色", "顏色", "色号", "色號", "color", "colour"];

function cleanToken(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function splitValues(value: string) {
  return value
    .split(/[、,，|/；;]+/)
    .map(cleanToken)
    .filter(Boolean)
    .slice(0, MAX_SKU_VARIANTS);
}

function splitDirectEntries(value: string) {
  return value
    .split(/\r?\n|[；;]+/)
    .flatMap((line) => line.split(/[,，]+/))
    .map(cleanToken)
    .filter(Boolean)
    .slice(0, MAX_SKU_VARIANTS);
}

function isColorKey(name: string) {
  const normalized = name.trim().toLowerCase();
  return COLOR_KEYS.some((key) => normalized.includes(key));
}

function cartesianProduct<T>(groups: T[][]) {
  return groups.reduce<T[][]>(
    (acc, group) => acc.flatMap((items) => group.map((item) => [...items, item])),
    [[]],
  );
}

export function parseSkuVariants(text: string): SkuVariant[] {
  const lines = text
    .split(/\r?\n/)
    .map(cleanToken)
    .filter(Boolean);
  const dimensions: Array<{ name: string; values: string[] }> = [];
  const directEntries: string[] = [];

  for (const line of lines) {
    const match = line.match(/^([^:：=]{1,24})[:：=](.+)$/);
    if (!match) {
      directEntries.push(...splitDirectEntries(line));
      continue;
    }
    const name = cleanToken(match[1]);
    const values = splitValues(match[2]);
    if (name && values.length) {
      dimensions.push({ name, values });
    }
  }

  const variants: SkuVariant[] = [];
  if (dimensions.length) {
    const combos = cartesianProduct(dimensions.map((item) => item.values)).slice(0, MAX_SKU_VARIANTS);
    for (const combo of combos) {
      const pairs = combo.map((value, index) => ({ name: dimensions[index].name, value }));
      const label = combo.join(" ");
      const color = pairs.find((item) => isColorKey(item.name))?.value;
      variants.push({
        label,
        raw: pairs.map((item) => `${item.name}:${item.value}`).join("; "),
        color,
        specs: pairs.filter((item) => !isColorKey(item.name)).map((item) => item.value),
        dimensions: pairs,
      });
    }
  }

  for (const entry of directEntries) {
    variants.push({
      label: entry,
      raw: entry,
      specs: [entry],
      dimensions: [],
    });
    if (variants.length >= MAX_SKU_VARIANTS) {
      break;
    }
  }

  return variants.slice(0, MAX_SKU_VARIANTS);
}

