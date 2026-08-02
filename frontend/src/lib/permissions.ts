/**
 * Dieselbe Access-Control-Definition wie im Backend, aus `@prowiki/shared`.
 *
 * Better Auth verlangt sie auf beiden Seiten. Sie hier erneut zu schreiben
 * wäre die klassische Quelle für eine Oberfläche, die einen Knopf anbietet,
 * den das Backend anschliessend mit 403 ablehnt.
 */
export {
  ac,
  roles,
  ROLE_NAMES,
  capabilitiesOf,
  roleHas,
  isRoleName,
  ANONYMOUS_CAPABILITIES,
  type RoleName,
  type Capability,
} from "@prowiki/shared/permissions";
