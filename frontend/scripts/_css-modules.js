const ROOT_NAME = "app";

export function generateScopedName(selector, filename) {
  const parts = filename.replaceAll("\\", "/").split("/");
  const name = parts.pop().replace(/\.css$/, "");
  const rootIndex = parts.findIndex((part) => part === ROOT_NAME);
  return `${parts.slice(rootIndex + 1).join("_")}_${name}__${selector}`;
}
