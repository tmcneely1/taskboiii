import { Notice, setTooltip } from "obsidian";
import type TaskNotesPlugin from "../main";
import type { TaskInfo } from "../types";
import { prepareInteractiveControl } from "./taskCardIndicators";

export const SCORE_BADGE_SELECTOR = ".task-card__score-badge";

/** Short numbers stay precise; large ones lose the decimal to keep the badge narrow. */
function formatScore(score: number): string {
	return score >= 10 ? `${Math.round(score)}` : score.toFixed(1);
}

/**
 * Renders the live task score on a card.
 *
 * The score is read from the service's cache rather than recomputed, because
 * cards render synchronously and in bulk. Clicking shows the full breakdown —
 * a ranking nobody can interrogate is a ranking nobody trusts.
 */
export function renderTaskCardScoreBadge(
	container: HTMLElement | null,
	task: TaskInfo,
	plugin: TaskNotesPlugin
): void {
	if (!container) return;
	const service = plugin.taskScoreService;
	if (!service || !plugin.settings.taskScore.enabled) return;
	if (!plugin.settings.taskScore.showBadgeOnCards) return;

	const scored = service.getCachedScore(task);
	// A task with no signal yet reads as noise on every card, so it is omitted.
	if (!scored || scored.tier === "none") return;

	const badge = container.createDiv({
		cls: `task-card__score-badge task-card__score-badge--${scored.tier}`,
		text: formatScore(scored.score),
		attr: { "aria-label": `Task score ${scored.score.toFixed(2)}` },
	});
	badge.dataset.tier = scored.tier;

	setTooltip(badge, service.explain(scored), { placement: "top" });
	prepareInteractiveControl(badge);
	badge.addEventListener("click", (event) => {
		event.stopPropagation();
		// Re-read rather than use the score captured at render time, so a long-
		// lived card explains what it is showing now.
		const current = service.getCachedScore(task) ?? scored;
		new Notice(service.explain(current), 12000);
	});
}

/**
 * Brings an existing card's badge in line with the current score, creating or
 * removing it as needed so recycled cards never show a stale number.
 */
export function updateTaskCardScoreBadge(
	card: HTMLElement,
	task: TaskInfo,
	plugin: TaskNotesPlugin
): void {
	const existing = card.querySelector<HTMLElement>(SCORE_BADGE_SELECTOR);
	const service = plugin.taskScoreService;
	const enabled =
		!!service && plugin.settings.taskScore.enabled && plugin.settings.taskScore.showBadgeOnCards;
	const scored = enabled ? service.getCachedScore(task) : null;

	if (!scored || scored.tier === "none") {
		existing?.remove();
		return;
	}

	if (!existing) {
		const badgesContainer = card.querySelector<HTMLElement>(".task-card__badges");
		renderTaskCardScoreBadge(badgesContainer, task, plugin);
		return;
	}

	const text = formatScore(scored.score);
	if (existing.textContent !== text) existing.setText(text);
	if (existing.dataset.tier !== scored.tier) {
		existing.removeClass(`task-card__score-badge--${existing.dataset.tier}`);
		existing.addClass(`task-card__score-badge--${scored.tier}`);
		existing.dataset.tier = scored.tier;
	}
	existing.setAttribute("aria-label", `Task score ${scored.score.toFixed(2)}`);
	setTooltip(existing, service!.explain(scored), { placement: "top" });
}
