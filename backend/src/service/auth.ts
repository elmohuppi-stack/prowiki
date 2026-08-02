import { db } from "../db/index.ts";
import { users } from "../db/schema.ts";
import { eq } from "drizzle-orm";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";

const JWT_SECRET = process.env.JWT_SECRET || "dev-secret-change-me";
const SALT_ROUNDS = 12;

// Admin-Credentials aus .env
const ADMIN_EMAIL = process.env.ADMIN_EMAIL || "admin@knora.app";
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin123";
const ADMIN_NAME = process.env.ADMIN_NAME || "Admin";

export async function register(email: string, password: string, name: string) {
  const existing = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (existing.length > 0) {
    throw new Error("Email already registered");
  }

  const password_hash = await bcrypt.hash(password, SALT_ROUNDS);
  const [user] = await db
    .insert(users)
    .values({
      email,
      password_hash,
      name,
      role: "viewer",
    })
    .returning();

  const token = createToken(user);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    token,
  };
}

export async function login(email: string, password: string) {
  // 1. Prüfe zuerst Admin-Credentials aus .env
  if (email === ADMIN_EMAIL && password === ADMIN_PASSWORD) {
    // Stelle sicher, dass der .env-Admin auch in der DB existiert (für FK-Constraints)
    const [existing] = await db
      .select()
      .from(users)
      .where(eq(users.email, ADMIN_EMAIL))
      .limit(1);

    let userId: number;
    if (existing) {
      userId = existing.id;
    } else {
      const password_hash = await bcrypt.hash(ADMIN_PASSWORD, SALT_ROUNDS);
      const [newUser] = await db
        .insert(users)
        .values({
          email: ADMIN_EMAIL,
          password_hash,
          name: ADMIN_NAME,
          role: "admin",
        })
        .returning();
      userId = newUser.id;
    }

    const token = createToken({
      id: userId,
      email: ADMIN_EMAIL,
      name: ADMIN_NAME,
      role: "admin",
    });
    return {
      user: { id: userId, email: ADMIN_EMAIL, name: ADMIN_NAME, role: "admin" },
      token,
    };
  }

  // 2. Fallback: DB-User (für zukünftige Multi-User-Szenarien)
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);
  if (!user) {
    throw new Error("Invalid credentials");
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw new Error("Invalid credentials");
  }

  const token = createToken(user);
  return {
    user: {
      id: user.id,
      email: user.email,
      name: user.name,
      role: user.role,
    },
    token,
  };
}

function createToken(user: {
  id: number;
  email: string;
  name: string;
  role: string;
}) {
  return jwt.sign(
    { id: user.id, email: user.email, name: user.name, role: user.role },
    JWT_SECRET,
    { expiresIn: "7d" },
  );
}
