/**
 * Which task-specific actions the Central AI$ task panel offers. Pure and
 * display-only: the server still refuses joins and submissions it does not
 * accept, and this grants no role or reward.
 */

/** A task a newcomer can take now: open, funded, nothing pending, no winner. */
export const centralTaskOpen = (task) =>
  task?.availability?.available !== false && task?.state === "open" && !task.pending && !task.winner;

/**
 * Offer "Review joining this project" from a task only while that task can
 * actually take a submission. A closed, accepted, unfunded or under-review task
 * never shows a join prompt beside its status banner. Project membership itself
 * is still shown separately ("joined" / "not joined") for every task.
 */
export const centralTaskJoinPrompt = (task, detail) =>
  Boolean(task && detail) && detail.joined !== true && centralTaskOpen(task);

/**
 * The label a member sees for a task's state. An operator hold wins; then the
 * server's own plain `status_label` (#408: contest and conditional states);
 * then the web's map. Never the raw state code (plain-language pass).
 */
export const centralTaskLabel = (task, labels = {}) => {
  if (task?.availability?.available === false) return "On hold while its instructions are fixed";
  if (typeof task?.status_label === "string" && task.status_label.trim() && task.status_label.length <= 200) return task.status_label;
  return labels[task?.state] || "Closed";
};
