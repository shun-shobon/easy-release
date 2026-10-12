import { type AST, getStaticTOMLValue, parseTOML } from "toml-eslint-parser";
import * as v from "valibot";

import { assertStableVersion } from "../utils/version";

export type PackageFormat = {
  versions(source: string): string[];
  update(source: string, version: string): string;
};

const recordSchema = v.record(v.string(), v.unknown());
const inheritedVersionSchema = v.strictObject({ workspace: v.literal(true) });

function stableVersion(value: unknown): string {
  const version = v.parse(v.string(), value);
  assertStableVersion(version);

  return version;
}

const jsonFormat: PackageFormat = {
  versions(source) {
    const data = v.parse(recordSchema, JSON.parse(source));

    return [stableVersion(data["version"])];
  },

  update(source, version) {
    const data = v.parse(recordSchema, JSON.parse(source));
    data["version"] = version;

    const indentation = /^[\t ]+(?=")/mu.exec(source)?.[0];
    const newline = source.includes("\r\n") ? "\r\n" : "\n";
    const trailingWhitespace = source.slice(source.trimEnd().length);
    const serialized = JSON.stringify(data, null, indentation);

    return serialized.replaceAll("\n", newline) + trailingWhitespace;
  },
};

function table(data: Record<string, unknown>, keys: string[]): Record<string, unknown> | undefined {
  let current: unknown = data;

  for (const key of keys) {
    if (!v.is(recordSchema, current)) {
      return undefined;
    }

    current = current[key];
  }

  return v.is(recordSchema, current) ? current : undefined;
}

function versionPaths(data: Record<string, unknown>): string[] {
  const paths: string[] = [];
  let inherited = false;

  for (const keys of [["package"], ["workspace", "package"]]) {
    const version = table(data, keys)?.["version"];
    if (version === undefined) {
      continue;
    }

    if (keys.length === 1 && v.is(inheritedVersionSchema, version)) {
      inherited = true;
      continue;
    }

    paths.push(JSON.stringify([...keys, "version"]));
  }

  if (paths.length === 0 && !inherited) {
    throw new Error("Cargo manifest has no package or workspace.package version");
  }

  return paths;
}

function* keyValues(
  nodes: Array<AST.TOMLKeyValue | AST.TOMLTable>,
  prefix: Array<string | number>,
): Generator<[string, AST.TOMLKeyValue]> {
  for (const node of nodes) {
    if (node.type === "TOMLTable") {
      yield* keyValues(node.body, node.resolvedKey);
      continue;
    }

    const path = [
      ...prefix,
      ...node.key.keys.map((key) => (key.type === "TOMLBare" ? key.name : key.value)),
    ];
    yield [JSON.stringify(path), node];

    if (node.value.type === "TOMLInlineTable") {
      yield* keyValues(node.value.body, path);
    }
  }
}

function versionNodes(source: string): AST.TOMLStringValue[] {
  const ast = parseTOML(source);
  const paths = new Set(versionPaths(v.parse(recordSchema, getStaticTOMLValue(ast))));
  const nodes: AST.TOMLStringValue[] = [];

  for (const [path, node] of keyValues(ast.body[0].body, [])) {
    if (!paths.has(path)) {
      continue;
    }

    if (node.value.type === "TOMLValue" && node.value.kind === "string") {
      nodes.push(node.value);
    }
  }

  if (nodes.length !== paths.size) {
    throw new Error("Cargo manifest version must be a string");
  }

  return nodes;
}

const cargoFormat: PackageFormat = {
  versions(source) {
    return versionNodes(source).map((node) => stableVersion(node.value));
  },

  update(source, version) {
    let updated = source;

    for (const node of versionNodes(source).toReversed()) {
      const quote = (node.style === "basic" ? '"' : "'").repeat(node.multiline ? 3 : 1);
      updated =
        updated.slice(0, node.range[0]) + quote + version + quote + updated.slice(node.range[1]);
    }

    return updated;
  },
};

export function packageFormat(file: string): PackageFormat {
  return file.split("/").at(-1) === "Cargo.toml" ? cargoFormat : jsonFormat;
}
