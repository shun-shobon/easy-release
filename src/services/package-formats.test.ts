import { describe, expect, it } from "vitest";

import { packageFormat } from "./package-formats";

const json = packageFormat("package.json");
const cargo = packageFormat("crates/app/Cargo.toml");

describe("JSON package format", () => {
  it("reads the version", () => {
    expect(json.versions('{"name":"app","version":"1.2.3"}')).toEqual(["1.2.3"]);
  });

  it("preserves indentation, CRLF, and trailing whitespace", () => {
    const source = '{\r\n\t"name": "app",\r\n\t"version": "1.2.3"\r\n}\r\n';

    expect(json.update(source, "1.3.0")).toBe(
      '{\r\n\t"name": "app",\r\n\t"version": "1.3.0"\r\n}\r\n',
    );
  });

  it.each(['{"version":null}', '{"version":"v1.2.3"}', "[]", "{"])("rejects %s", (source) => {
    expect(() => json.versions(source)).toThrow();
  });
});

describe("Cargo package format", () => {
  it("is selected only for files named Cargo.toml", () => {
    expect(packageFormat("Cargo.toml")).toBe(cargo);
    expect(packageFormat("Cargo.toml.json")).toBe(json);
  });

  it("updates the package version without touching other content", () => {
    const source = [
      "# app",
      "[package]",
      'name = "app"',
      "version   =  '1.2.3' # current",
      "",
      "[dependencies]",
      'serde = { version = "1.0.0" }',
      "",
    ].join("\n");

    expect(cargo.versions(source)).toEqual(["1.2.3"]);
    expect(cargo.update(source, "2.0.0")).toBe(
      source.replace("version   =  '1.2.3'", "version   =  '2.0.0'"),
    );
  });

  it("updates both package and workspace.package versions with CRLF", () => {
    const source = [
      "[workspace]",
      'members = ["crates/*"]',
      "",
      "[ workspace . package ]",
      'version = "1.0.0"',
      "",
      "[package]",
      'name = "root"',
      'version = "0.9.0"',
      "",
    ].join("\r\n");

    expect(cargo.versions(source)).toEqual(["1.0.0", "0.9.0"]);
    expect(cargo.update(source, "1.1.0")).toBe(
      source.replace('"1.0.0"', '"1.1.0"').replace('"0.9.0"', '"1.1.0"'),
    );
  });

  it("does not update versions in other tables", () => {
    const source = [
      "[package]",
      'version = "1.0.0"',
      "",
      "[[bin]]",
      'version = "1.0.0"',
      "",
      "[dependencies.foo]",
      'version = "1.0.0"',
      "",
    ].join("\n");

    expect(cargo.update(source, "1.0.1")).toBe(source.replace('"1.0.0"', '"1.0.1"'));
  });

  it("leaves an inherited workspace version as is", () => {
    const source = '[package]\nname = "app"\nversion.workspace = true\n';

    expect(cargo.versions(source)).toEqual([]);
    expect(cargo.update(source, "1.0.0")).toBe(source);
  });

  it.each([
    { name: "a manifest without a version", source: '[package]\nname = "app"\n' },
    { name: "a virtual manifest without a version", source: '[workspace]\nmembers = ["a"]\n' },
    { name: "a prerelease version", source: '[package]\nversion = "1.0.0-alpha"\n' },
    { name: "a non-string version", source: "[package]\nversion = 1\n" },
    {
      name: "an inherited workspace.package version",
      source: "[workspace.package]\nversion.workspace = true\n",
    },
    { name: "invalid TOML", source: "[package\n" },
  ])("rejects $name", ({ source }) => {
    expect(() => cargo.versions(source)).toThrow();
  });

  it.each([
    { name: "dotted keys", source: 'package.version = "1.0.0" # current\n' },
    { name: "dotted table keys", source: '[package]\nname = "app"\n"version" = "1.0.0"\n' },
    { name: "inline tables", source: 'workspace = { package = { version = "1.0.0" } }\n' },
  ])("updates versions defined with $name", ({ source }) => {
    expect(cargo.versions(source)).toEqual(["1.0.0"]);
    expect(cargo.update(source, "1.0.1")).toBe(source.replace('"1.0.0"', '"1.0.1"'));
  });

  it("does not rewrite text inside multiline strings", () => {
    const source = [
      'description = """',
      "[package]",
      'version = "1.0.0"',
      '"""',
      "",
      "[package]",
      'version = "1.0.0"',
      "",
    ].join("\n");

    expect(cargo.update(source, "1.0.1")).toBe(source.replace(/"1\.0\.0"\n$/u, '"1.0.1"\n'));
  });
});
