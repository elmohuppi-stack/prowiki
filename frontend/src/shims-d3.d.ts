// d3 wird nur in GraphView.vue genutzt (mit expliziten any-Casts).
// Ambient-Deklaration statt @types/d3, um keine große Dev-Dependency einzuführen.
declare module "d3";
