export function validateActionInput(descriptor, input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw codedError("invalid_input_type", "action input must be an object");
  }
  if (descriptor.risk === "dangerous") {
    throw codedError("dangerous_action_rejected", `dangerous action is not allowed: ${descriptor.id}`);
  }
  for (const name of descriptor.input_schema.required || []) required(input, ...fieldNames(name));
  const properties = descriptor.input_schema.properties || {};
  for (const key of Object.keys(input || {})) {
    if (!Object.hasOwn(properties, key)) {
      throw codedError("invalid_input_field", `invalid input field for ${descriptor.id}: ${key}`);
    }
  }
  for (const [key, specValue] of Object.entries(properties)) {
    const value = input?.[key];
    if (value === undefined || value === null || String(value).trim() === "") continue;
    validateInputSpec(key, specValue, value);
  }
}

function validateInputSpec(key, specValue, value) {
  const spec = String(specValue).replace(/\?$/, "");
  const parts = spec.split("|").filter(Boolean);
  if (parts.length > 1) {
    if (parts.some((part) => inputMatchesSpecPart(part, value))) return;
    if (parts.every((part) => !isTypeSpec(part))) {
      throw codedError("invalid_input_value", `${key} must be one of ${spec}`);
    }
    throw codedError("invalid_input_type", `${key} must match ${spec}`);
  }
  if (inputMatchesSpecPart(spec, value)) return;
  if (isTypeSpec(spec)) throw codedError("invalid_input_type", `${key} must be ${spec}`);
  throw codedError("invalid_input_value", `${key} must be ${spec}`);
}

function inputMatchesSpecPart(spec, value) {
  if (spec === "string") return typeof value === "string";
  if (spec === "number") return typeof value === "number" && Number.isFinite(value);
  if (spec === "boolean") return typeof value === "boolean";
  if (spec === "array") return Array.isArray(value);
  if (spec === "string[]") return Array.isArray(value) && value.every((item) => typeof item === "string");
  return typeof value === "string" && String(value).toLowerCase() === spec;
}

function isTypeSpec(spec) {
  return ["string", "number", "boolean", "array", "string[]"].includes(spec);
}

function fieldNames(name) {
  return [name, ...fieldAliases(name)];
}

function fieldAliases(name) {
  return {
    labels: ["label"],
    options: ["option"],
    tags: ["tag"],
    virtual_path: ["virtualPath"],
    target_kind: ["targetKind"],
    target_id: ["targetId"],
    rel_path: ["relPath"],
    session_id: ["chat_session_id", "raw_id"],
    resume_session_id: ["resume"],
  }[name] || [];
}

export function required(input, ...names) {
  for (const name of names) {
    const value = input?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== "") return String(value);
  }
  throw codedError(`missing_input_${names[0]}`, `missing input: ${names.join("|")}`);
}

export function normalizeOptions(values) {
  const list = Array.isArray(values) ? values : values ? [values] : [];
  return list.map((value) => {
    if (typeof value === "string") return value;
    const key = String(value?.key || "").trim();
    const label = String(value?.label || "").trim();
    if (!key || !label) throw codedError("invalid_option", "decision option requires key and label");
    return `${key}=${label}${value?.recommended ? ":rec" : ""}`;
  });
}

export function codedError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
