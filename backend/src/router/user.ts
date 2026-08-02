// Schlanke User-Liste für Auswahlfelder (Mitglied einladen, Besitzer wechseln).
// Bewusst getrennt von /admin/users: dort hängen Rollenverwaltung und Löschen
// dran, die Admins vorbehalten sind. Hier gibt es nur id/name/email.

import { Hono } from "hono";
import { asc } from "drizzle-orm";
import { sessionMiddleware } from "../middleware/auth.ts";
import { db } from "../db/index.ts";
import { user } from "../db/schema.ts";

const userRouter = new Hono();
userRouter.use("*", sessionMiddleware);

userRouter.get("/", async (c) => {
  const list = await db
    .select({ id: user.id, name: user.name, email: user.email })
    .from(user)
    .orderBy(asc(user.name));
  return c.json({ users: list });
});

export { userRouter };
