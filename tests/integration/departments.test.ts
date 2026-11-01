import { afterEach, describe, expect, it } from "vitest";
import type { FastifyInstance } from "fastify";
import { ADMIN_ID, auth, createTestApp, departmentBody } from "../helpers/app.js";

describe("departments", () => {
  let app: FastifyInstance;

  afterEach(async () => {
    await app.close();
  });

  it("creates, reads, updates, and lists a department", async () => {
    app = await createTestApp();
    const created = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("alpha"),
    });
    expect(created.statusCode).toBe(201);
    const department = created.json().department;
    expect(department.status).toBe("proposed");
    expect(department.creationSource).toBe("api");
    expect(department.specificationVersion).toBe("1.0.0");

    const fetched = await app.inject({
      method: "GET",
      url: `/api/v1/departments/${department.id}`,
      headers: auth(ADMIN_ID),
    });
    expect(fetched.statusCode).toBe(200);
    expect(fetched.json().department.slug).toBe("department-alpha");

    const updated = await app.inject({
      method: "PATCH",
      url: `/api/v1/departments/${department.id}`,
      headers: auth(ADMIN_ID),
      payload: { purpose: "Updated purpose" },
    });
    expect(updated.statusCode).toBe(200);
    expect(updated.json().department.purpose).toBe("Updated purpose");
    expect(updated.json().department.status).toBe("proposed");
  });

  it("rejects duplicate names and slugs", async () => {
    app = await createTestApp();
    const first = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("dup"),
    });
    expect(first.statusCode).toBe(201);
    const duplicate = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("dup"),
    });
    expect(duplicate.statusCode).toBe(409);
    expect(duplicate.json().error.code).toBe("CONFLICT");
  });

  it("rejects a hierarchy cycle and returns parent and children", async () => {
    app = await createTestApp();
    const parent = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: departmentBody("parent"),
    });
    const child = await app.inject({
      method: "POST",
      url: "/api/v1/departments",
      headers: auth(ADMIN_ID),
      payload: {
        ...departmentBody("child"),
        parentDepartmentId: parent.json().department.id,
      },
    });
    expect(child.statusCode).toBe(201);
    const cycle = await app.inject({
      method: "PATCH",
      url: `/api/v1/departments/${parent.json().department.id}`,
      headers: auth(ADMIN_ID),
      payload: { parentDepartmentId: child.json().department.id },
    });
    expect(cycle.statusCode).toBe(409);
    expect(cycle.json().error.code).toBe("HIERARCHY_CYCLE");

    const hierarchy = await app.inject({
      method: "GET",
      url: `/api/v1/departments/${parent.json().department.id}/hierarchy`,
      headers: auth(ADMIN_ID),
    });
    expect(hierarchy.statusCode).toBe(200);
    expect(hierarchy.json().parent).toBeNull();
    expect(hierarchy.json().children).toHaveLength(1);
    expect(hierarchy.json().children[0].id).toBe(child.json().department.id);
  });

  it("paginates department lists without duplicates", async () => {
    app = await createTestApp();
    for (let index = 0; index < 25; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/v1/departments",
        headers: auth(ADMIN_ID),
        payload: departmentBody(`page-${index}`),
      });
      expect(response.statusCode).toBe(201);
    }
    const seen = new Set<string>();
    let cursor: string | null = null;
    let pages = 0;
    do {
      const url: string = cursor
        ? `/api/v1/departments?limit=10&cursor=${encodeURIComponent(cursor)}`
        : "/api/v1/departments?limit=10";
      const response = await app.inject({ method: "GET", url, headers: auth(ADMIN_ID) });
      expect(response.statusCode).toBe(200);
      const body = response.json() as {
        data: Array<{ id: string }>;
        page: { nextCursor: string | null };
      };
      expect(body.data.length).toBeLessThanOrEqual(10);
      for (const department of body.data) {
        expect(seen.has(department.id)).toBe(false);
        seen.add(department.id);
      }
      cursor = body.page.nextCursor;
      pages += 1;
    } while (cursor);
    expect(seen.size).toBe(25);
    expect(pages).toBe(3);
  });
});
