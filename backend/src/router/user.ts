// Schlanke User-Liste für Auswahlfelder (Mitglied einladen, Besitzer wechseln).
// Bewusst getrennt von /admin/users: dort hängen Rollenverwaltung und Löschen
// dran, die Admins vorbehalten sind. Hier gibt es nur id/name/email.

import { Hono } from "hono";
import { asc } from "drizzle-orm";
import { authMiddleware } from "../middleware/auth.ts";
import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";

const userRouter = new Hono();
userRouter.use("*", authMiddleware);

userRouter.get("/", async (c) => {
  const list = await db
    .select({ id: users.id, name: users.name, email: users.email })
    .from(users)
    .orderBy(asc(users.name));
  return c.json({ users: list });
});

export { userRouter };
