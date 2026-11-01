import type { Actor } from "@ai-colony/contracts";
import { DomainError } from "../errors/domain-error.js";
import { type Permission, ROLE_PERMISSIONS } from "./permissions.js";

export class Authorizer {
  assert(actor: Actor, permission: Permission): void {
    const granted = ROLE_PERMISSIONS[actor.role];
    if (!granted.has(permission)) {
      throw new DomainError("AUTHORIZATION_DENIED", `Missing permission ${permission}`, 403, {
        permission,
        role: actor.role,
      });
    }
  }

  assertAny(actor: Actor, permissions: readonly Permission[]): void {
    const granted = ROLE_PERMISSIONS[actor.role];
    if (!permissions.some((permission) => granted.has(permission))) {
      throw new DomainError("AUTHORIZATION_DENIED", "Missing required permission", 403, {
        permissions: [...permissions],
        role: actor.role,
      });
    }
  }
}
