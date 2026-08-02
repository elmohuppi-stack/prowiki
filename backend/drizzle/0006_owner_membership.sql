-- Backfill: Jeder bestehende Workspace bekommt für seinen Ersteller eine
-- owner-Mitgliedschaft. Bisher hing der Zugriff allein an workspaces.created_by;
-- mit dem Ownership-Wechsel muss die Mitgliedschaft die tragende Beziehung sein,
-- sonst verliert der bisherige Besitzer den Workspace beim Übertragen.
INSERT INTO "workspace_members" ("workspace_id", "user_id", "role")
SELECT w."id", w."created_by", 'owner'
FROM "workspaces" AS w
ON CONFLICT ("workspace_id", "user_id") DO UPDATE SET "role" = 'owner';
--> statement-breakpoint
-- Altwert "admin" auf die neue Rolle "owner" ziehen (gleiche Bedeutung).
UPDATE "workspace_members" SET "role" = 'owner' WHERE "role" = 'admin';
