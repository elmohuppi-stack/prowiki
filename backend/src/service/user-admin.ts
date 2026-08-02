import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { eq, desc } from "drizzle-orm";
import bcrypt from "bcryptjs";

const SALT_ROUNDS = 12;

const publicColumns = {
  id: users.id,
  email: users.email,
  name: users.name,
  role: users.role,
  created_at: users.created_at,
  updated_at: users.updated_at,
};

export async function listUsers() {
  return await db
    .select({
      id: users.id,
      email: users.email,
      name: users.name,
      role: users.role,
      created_at: users.created_at,
      updated_at: users.updated_at,
    })
    .from(users)
    .orderBy(desc(users.created_at));
}

export async function createUser(
  email: string,
  password: string,
  name: string,
  role: string,
) {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    throw new Error("Email already registered");
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const [user] = await db
    .insert(users)
    .values({ email, password_hash, name, role })
    .returning(publicColumns);
  return user;
}

export async function updateUserRole(userId: number, role: string) {
  const [user] = await db
    .update(users)
    .set({ role, updated_at: new Date() })
    .where(eq(users.id, userId))
    .returning(publicColumns);
  return user || null;
}

export async function deleteUser(userId: number) {
  await db.delete(users).where(eq(users.id, userId));
}
