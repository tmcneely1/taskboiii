import { TFile } from "obsidian";
import type TaskNotesPlugin from "../main";
import type { TaskInfo } from "../types";
import type { TaskScoreSettings } from "../types/settings";

export type ScoreTier = "red" | "gold" | "blue" | "gray" | "none";

const TIER_THRESHOLDS: { tier: ScoreTier; min: number }[] = [
	{ tier: "red", min: 10 },
	{ tier: "gold", min: 5 },
	{ tier: "blue", min: 2 },
	{ tier: "gray", min: 1 },
];

/** Every contribution to a score, kept so the number can be explained. */
export interface ScoreBreakdown {
	attention: number;
	dueToday: number;
	deadline: number;
	duration: number;
	blocking: number;
	total: number;
	attentionDays: number;
	dailyRate: number;
}

export interface ScoredTask {
	task: TaskInfo;
	score: number;
	tier: ScoreTier;
	breakdown: ScoreBreakdown;
}

/** Shape of the attention log on disk. */
interface AttentionData {
	version: 1;
	/** note path -> ISO dates the note was opened. */
	days: Record<string, string[]>;
	/** note path -> last tier written back, so writes only happen on change. */
	tiers?: Record<string, ScoreTier>;
}

const STORE_FILE = "task-score.json";

/** Sortable rank for a tier. Alphabetical tier names sort meaninglessly. */
export function rankFor(tier: ScoreTier): number {
	switch (tier) {
		case "red":
			return 4;
		case "gold":
			return 3;
		case "blue":
			return 2;
		case "gray":
			return 1;
		default:
			return 0;
	}
}

export function tierFor(score: number): ScoreTier {
	for (const { tier, min } of TIER_THRESHOLDS) {
		if (score >= min) return tier;
	}
	return "none";
}

/** Local-date ISO string. Attention is counted in calendar days, not instants. */
export function todayISO(now = new Date()): string {
	const m = `${now.getMonth() + 1}`.padStart(2, "0");
	const d = `${now.getDate()}`.padStart(2, "0");
	return `${now.getFullYear()}-${m}-${d}`;
}

/** ISO date arithmetic on the calendar date, avoiding timezone drift. */
export function addDays(iso: string, days: number): string {
	const [year, month, day] = iso.split("-").map(Number);
	const date = new Date(year, month - 1, day);
	date.setDate(date.getDate() + days);
	const m = `${date.getMonth() + 1}`.padStart(2, "0");
	const d = `${date.getDate()}`.padStart(2, "0");
	return `${date.getFullYear()}-${m}-${d}`;
}

/**
 * Attention-weighted task scoring.
 *
 * Score accrues on the days a task's note is actually opened, so a task you
 * keep returning to outranks one that merely looks urgent in its frontmatter.
 * The day log is the only state here that cannot be recomputed — Obsidian keeps
 * no history of which notes were opened when, so it necessarily starts empty on
 * first install and there is no honest way to backfill it.
 *
 * It is stored beside the plugin's settings rather than inside them, so a
 * settings write can never clobber it and the log does not bloat a synced
 * settings file.
 */
export class TaskScoreService {
	private data: AttentionData = { version: 1, days: {}, tiers: {} };
	private loaded = false;
	private saveTimer: ReturnType<typeof setTimeout> | null = null;
	private listeners = new Set<() => void>();

	constructor(private plugin: TaskNotesPlugin) {}

	private get settings(): TaskScoreSettings {
		return this.plugin.settings.taskScore;
	}

	private get storePath(): string {
		const dir = this.plugin.manifest.dir ?? "";
		return `${dir}/${STORE_FILE}`;
	}

	onChange(listener: () => void): () => void {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}

	private notify(): void {
		for (const listener of this.listeners) listener();
	}

	async load(): Promise<void> {
		if (this.loaded) return;
		this.loaded = true;
		try {
			const adapter = this.plugin.app.vault.adapter;
			if (await adapter.exists(this.storePath)) {
				const parsed = JSON.parse(await adapter.read(this.storePath)) as AttentionData;
				if (parsed && typeof parsed === "object" && parsed.days) {
					this.data = { version: 1, days: parsed.days, tiers: parsed.tiers ?? {} };
				}
			}
		} catch (error) {
			// A corrupt log must not stop the plugin loading; start fresh instead.
			console.error("Task Score: could not read the attention log", error);
			this.data = { version: 1, days: {}, tiers: {} };
		}
	}

	/** Writes are debounced — opening notes should not hit the disk every time. */
	private scheduleSave(): void {
		if (this.saveTimer) clearTimeout(this.saveTimer);
		this.saveTimer = setTimeout(() => {
			this.saveTimer = null;
			void this.save();
		}, 2000);
	}

	async save(): Promise<void> {
		try {
			await this.plugin.app.vault.adapter.write(
				this.storePath,
				JSON.stringify(this.data, null, 2)
			);
		} catch (error) {
			console.error("Task Score: could not write the attention log", error);
		}
	}

	async flush(): Promise<void> {
		if (this.saveTimer) {
			clearTimeout(this.saveTimer);
			this.saveTimer = null;
			await this.save();
		}
	}

	/** Records a note as opened today. No-op after the first open of the day. */
	recordOpen(path: string, today = todayISO()): void {
		if (!this.settings.enabled || !path.endsWith(".md")) return;
		const existing = this.data.days[path];
		if (!existing) {
			this.data.days[path] = [today];
		} else if (existing[existing.length - 1] === today) {
			// Already counted today; nothing changes, so skip the save and repaint.
			return;
		} else {
			existing.push(today);
		}
		this.scheduleSave();
		this.notify();
	}

	handleRename(oldPath: string, newPath: string): void {
		const entries = this.data.days[oldPath];
		if (!entries) return;
		delete this.data.days[oldPath];
		const target = this.data.days[newPath];
		this.data.days[newPath] = target
			? Array.from(new Set([...target, ...entries])).sort()
			: entries;
		const tier = this.data.tiers?.[oldPath];
		if (tier && this.data.tiers) {
			delete this.data.tiers[oldPath];
			this.data.tiers[newPath] = tier;
		}
		this.scheduleSave();
	}

	handleDelete(path: string): void {
		if (!(path in this.data.days)) return;
		delete this.data.days[path];
		if (this.data.tiers) delete this.data.tiers[path];
		this.scheduleSave();
	}

	/** Days the note was opened inside the retention window. */
	attentionDays(path: string, today = todayISO()): number {
		const days = this.data.days[path];
		if (!days || days.length === 0) return 0;
		const cutoff = addDays(today, -this.settings.attentionWindowDays);
		return days.filter((day) => day >= cutoff && day <= today).length;
	}

	/** Drops entries outside the retention window, bounding the stored size. */
	prune(today = todayISO()): void {
		const cutoff = addDays(today, -this.settings.attentionWindowDays);
		let changed = false;
		for (const path of Object.keys(this.data.days)) {
			const kept = this.data.days[path].filter((day) => day >= cutoff);
			if (kept.length === this.data.days[path].length) continue;
			changed = true;
			if (kept.length === 0) delete this.data.days[path];
			else this.data.days[path] = kept;
		}
		if (changed) this.scheduleSave();
	}

	private isImportant(task: TaskInfo): boolean {
		return this.settings.importantPriorities.includes((task.priority ?? "").toLowerCase());
	}

	private isUrgent(task: TaskInfo): boolean {
		return this.settings.urgentPriorities.includes((task.priority ?? "").toLowerCase());
	}

	/** Points per opened day, after the Urgent and Important multipliers. */
	private dailyRate(task: TaskInfo): number {
		let rate = this.settings.baseDailyRate;
		if (this.isImportant(task)) rate *= this.settings.importantMultiplier;
		if (this.isUrgent(task)) rate *= this.settings.urgentMultiplier;
		return rate;
	}

	/**
	 * A time estimate that was set at all signals the task was considered; a
	 * short one is a quick win worth surfacing. Scales linearly from the full
	 * bonus at `quickWinMinutes` down to zero at four times that.
	 */
	private durationBonus(task: TaskInfo): number {
		const minutes = task.timeEstimate;
		if (!minutes || minutes <= 0) return 0;
		const { quickWinMinutes, maxDurationBonus } = this.settings;
		const ceiling = quickWinMinutes * 4;
		if (minutes <= quickWinMinutes) return maxDurationBonus;
		if (minutes >= ceiling) return 0;
		return maxDurationBonus * (1 - (minutes - quickWinMinutes) / (ceiling - quickWinMinutes));
	}

	private ownBreakdown(task: TaskInfo, today: string): ScoreBreakdown {
		const days = this.attentionDays(task.path, today);
		const rate = this.dailyRate(task);
		const attention = days * rate;

		const scheduled = (task.scheduled ?? "").slice(0, 10);
		const due = (task.due ?? "").slice(0, 10);
		const dueToday = scheduled && scheduled <= today ? this.settings.dueTodayBonus : 0;
		const deadline = due && due <= today ? this.settings.deadlineBonus : 0;
		const duration = this.durationBonus(task);

		return {
			attention,
			dueToday,
			deadline,
			duration,
			blocking: 0,
			total: attention + dueToday + deadline + duration,
			attentionDays: days,
			dailyRate: rate,
		};
	}

	/**
	 * Scores a set of tasks, resolving blocking relationships.
	 *
	 * A blocked task passes a share of its score up to whatever blocks it, so a
	 * small task holding up important work rises. Resolution is memoized
	 * depth-first with a visiting set, so a dependency cycle contributes zero
	 * rather than recursing forever.
	 */
	scoreTasks(tasks: TaskInfo[], today = todayISO()): ScoredTask[] {
		const byPath = new Map(tasks.map((task) => [task.path, task]));
		const resolved = new Map<string, number>();
		const visiting = new Set<string>();
		const transfer = this.settings.blockingTransfer;

		const totalFor = (path: string): number => {
			const cached = resolved.get(path);
			if (cached !== undefined) return cached;
			const task = byPath.get(path);
			if (!task) return 0;
			if (visiting.has(path)) return 0;

			visiting.add(path);
			let total = this.ownBreakdown(task, today).total;
			for (const blockedPath of task.blocking ?? []) {
				total += totalFor(blockedPath) * transfer;
			}
			visiting.delete(path);

			resolved.set(path, total);
			return total;
		};

		return tasks.map((task) => {
			const breakdown = this.ownBreakdown(task, today);
			let blocking = 0;
			for (const blockedPath of task.blocking ?? []) {
				blocking += totalFor(blockedPath) * transfer;
			}
			breakdown.blocking = blocking;
			breakdown.total += blocking;

			return {
				task,
				score: breakdown.total,
				tier: tierFor(breakdown.total),
				breakdown,
			};
		});
	}

	/** Scores every known task, highest first. */
	async scoreAll(): Promise<ScoredTask[]> {
		await this.load();
		const tasks = await this.plugin.cacheManager.getAllTasks();
		const open = tasks.filter((task) => !task.archived);
		const scored = this.scoreTasks(open);
		scored.sort((a, b) => b.score - a.score || a.task.title.localeCompare(b.task.title));
		return scored;
	}

	/**
	 * Writes the tier to frontmatter, but only for tasks whose tier changed, so
	 * Bases views can sort on it without every task note being rewritten daily.
	 */
	async syncTiers(scored: ScoredTask[]): Promise<number> {
		if (!this.settings.writeBackOnTierChange) return 0;
		const property = this.settings.writeBackProperty.trim();
		if (!property) return 0;

		this.data.tiers ??= {};
		let written = 0;

		for (const item of scored) {
			if (this.data.tiers[item.task.path] === item.tier) continue;
			const file = this.plugin.app.vault.getAbstractFileByPath(item.task.path);
			if (!(file instanceof TFile)) continue;
			try {
				await this.plugin.app.fileManager.processFrontMatter(
					file,
					(frontmatter: Record<string, unknown>) => {
						frontmatter[property] = item.tier;
						// Both are written together and only on a tier change, so the
						// rank stays exact while the churn stays bounded.
						frontmatter[`${property}Rank`] = rankFor(item.tier);
					}
				);
				this.data.tiers[item.task.path] = item.tier;
				written++;
			} catch (error) {
				console.error(`Task Score: could not write the tier to ${item.task.path}`, error);
			}
		}

		if (written > 0) this.scheduleSave();
		return written;
	}

	/** Human-readable account of where a score came from. */
	explain(item: ScoredTask): string {
		const b = item.breakdown;
		const lines = [`${item.task.title} — ${item.score.toFixed(2)} (${item.tier})`];
		if (b.attention > 0) {
			lines.push(
				`  attention  +${b.attention.toFixed(2)}  (${b.attentionDays} days opened × ${b.dailyRate.toFixed(2)}/day)`
			);
		} else {
			lines.push("  attention   0.00  (note not opened since tracking began)");
		}
		if (b.dueToday) lines.push(`  scheduled  +${b.dueToday.toFixed(2)}`);
		if (b.deadline) lines.push(`  due        +${b.deadline.toFixed(2)}`);
		if (b.duration) lines.push(`  quick win  +${b.duration.toFixed(2)}`);
		if (b.blocking) lines.push(`  blocking   +${b.blocking.toFixed(2)}`);
		return lines.join("\n");
	}

	stats(): { notesTracked: number; totalDays: number } {
		const paths = Object.keys(this.data.days);
		let totalDays = 0;
		for (const path of paths) totalDays += this.data.days[path].length;
		return { notesTracked: paths.length, totalDays };
	}

	/** Clears the attention log. Irreversible — the history cannot be rebuilt. */
	async reset(): Promise<void> {
		this.data = { version: 1, days: {}, tiers: {} };
		await this.save();
		this.notify();
	}
}
