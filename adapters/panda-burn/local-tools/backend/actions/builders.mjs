import { required } from "./validation.mjs";

export function action(id, target, risk, title, options) {
  const descriptor = {
    id,
    target,
    risk,
    title,
    description: options.description || title,
    input_schema: {
      type: "object",
      required: options.required || [],
      properties: options.properties || {},
    },
    examples: options.examples || [],
    side_effects: options.side_effects || "none",
    confirm_required: options.confirm_required ?? ["write-local", "agent", "dangerous"].includes(risk),
    toCli: options.toCli,
  };
  for (const key of ["interface_kind", "tool_surface", "scope", "confirmation", "owned_by"]) {
    if (options[key] !== undefined) descriptor[key] = options[key];
  }
  return descriptor;
}

export function phone(id, title, properties, example, options = {}) {
  return action(id, "phone", "safe-ui", title, {
    description: title,
    required: Object.entries(properties).filter(([, spec]) => !String(spec).endsWith("?")).map(([name]) => name),
    properties,
    examples: [example],
    side_effects: options.side_effects || "changes Burn App visible UI state only",
    confirm_required: options.confirm_required,
    interface_kind: options.interface_kind,
    tool_surface: options.tool_surface,
    scope: options.scope,
    confirmation: options.confirmation,
    owned_by: options.owned_by,
  });
}

export function statusAction(id, area, verb) {
  return action(id, "desktop", "write-local", `${area} ${verb}`, {
    description: `Run burn ${area} ${verb} for an existing id.`,
    required: ["id"],
    properties: { id: "string" },
    examples: [{ id: `${area.slice(0, 3)}_...` }],
    side_effects: `updates .burn/${area}s`,
    toCli: (input, project) => [area, verb, required(input, "id"), "--project", project, "--json"],
  });
}

export function publicDescriptor(item) {
  return {
    id: item.id,
    title: item.title,
    target: item.target,
    risk: item.risk,
    description: item.description,
    input_schema: item.input_schema,
    examples: item.examples,
    side_effects: item.side_effects,
    confirm_required: item.confirm_required,
    ...(item.interface_kind ? { interface_kind: item.interface_kind } : {}),
    ...(item.tool_surface ? { tool_surface: item.tool_surface } : {}),
    ...(item.scope ? { scope: item.scope } : {}),
    ...(item.confirmation ? { confirmation: item.confirmation } : {}),
    ...(item.owned_by ? { owned_by: item.owned_by } : {}),
  };
}

export function opt(args, flag, value) {
  if (value === undefined || value === null || String(value).trim() === "") return;
  args.push(flag, String(value));
}

export function repeat(args, flag, values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  for (const value of list) {
    if (value === undefined || value === null || String(value).trim() === "") continue;
    args.push(flag, String(value));
  }
}
