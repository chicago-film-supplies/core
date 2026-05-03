import { assertEquals } from "@std/assert";
import { PERMISSIONS, type Permission } from "../src/permissions.ts";
import {
  SEARCH_PERMISSION_BY_ALIAS,
  typesenseSchemas,
  type TypesenseAlias,
} from "../src/typesense/mod.ts";

const PERMISSION_SET: ReadonlySet<Permission> = new Set(PERMISSIONS);

Deno.test("every enabled Typesense alias has a .search permission mapping", () => {
  for (const alias of Object.keys(typesenseSchemas) as TypesenseAlias[]) {
    const config = typesenseSchemas[alias];
    if (config.enabled === false) continue;
    const perm = SEARCH_PERMISSION_BY_ALIAS[alias];
    assertEquals(
      typeof perm,
      "string",
      `${alias}: missing entry in SEARCH_PERMISSION_BY_ALIAS — add a .search permission to permissions.ts and map it here`,
    );
  }
});

Deno.test("every SEARCH_PERMISSION_BY_ALIAS value exists in PERMISSIONS", () => {
  for (const [alias, perm] of Object.entries(SEARCH_PERMISSION_BY_ALIAS)) {
    if (!perm) continue;
    assertEquals(
      PERMISSION_SET.has(perm),
      true,
      `${alias}: mapped permission "${perm}" is not in the PERMISSIONS catalog`,
    );
  }
});

Deno.test("every .search permission in the catalog is referenced by an alias", () => {
  const mappedPerms = new Set(
    Object.values(SEARCH_PERMISSION_BY_ALIAS).filter(
      (p): p is Permission => typeof p === "string",
    ),
  );
  for (const perm of PERMISSIONS) {
    if (!perm.endsWith(".search")) continue;
    assertEquals(
      mappedPerms.has(perm),
      true,
      `${perm}: cataloged but not mapped from any Typesense alias — add a SEARCH_PERMISSION_BY_ALIAS entry or remove the permission`,
    );
  }
});
