import { Notice } from "obsidian";
import TaskNotesPlugin from "../../main";
import {
	createSettingGroup,
	configureTextSetting,
	configureToggleSetting,
	configureNumberSetting,
	configureButtonSetting,
} from "../components/settingHelpers";

/** Turns a comma-separated list into trimmed, lowercase, non-empty values. */
function parseList(value: string): string[] {
	return value
		.split(",")
		.map((entry) => entry.trim().toLowerCase())
		.filter((entry) => entry.length > 0);
}

/**
 * Renders the Task Score tab — the attention-weighted scoring model and the
 * weights that drive it.
 */
export function renderTaskScoreTab(
	container: HTMLElement,
	plugin: TaskNotesPlugin,
	save: () => void
): void {
	container.empty();

	const score = () => plugin.settings.taskScore;

	// How it works -----------------------------------------------------------
	const intro = container.createDiv({ cls: "settings-view__intro" });
	intro.createEl("p", {
		text:
			"Task Score ranks tasks by how much attention they actually get. A task " +
			"accrues points on each day you open its note, multiplied by whether it is " +
			"important or urgent, plus flat bonuses for being scheduled, overdue, or quick.",
	});
	const note = intro.createEl("p");
	note.createEl("strong", { text: "Attention history starts when you enable this. " });
	note.appendText(
		"Obsidian keeps no record of which notes you opened on which day, so there is no " +
			"way to backfill it. Expect scores to be flat for the first couple of weeks, " +
			"then separate out as you work."
	);

	const stats = plugin.taskScoreService?.stats();
	if (stats) {
		intro.createEl("p", {
			cls: "setting-item-description",
			text:
				`Tracking ${stats.notesTracked} note${stats.notesTracked === 1 ? "" : "s"}, ` +
				`${stats.totalDays} recorded open${stats.totalDays === 1 ? "" : "s"}.`,
		});
	}

	// Core -------------------------------------------------------------------
	createSettingGroup(container, { heading: "Scoring" }, (group) => {
		group.addSetting((setting) =>
			configureToggleSetting(setting, {
				name: "Enable task score",
				desc: "Track note opens and rank tasks by the resulting score.",
				getValue: () => score().enabled,
				setValue: (value) => {
					score().enabled = value;
					save();
				},
			})
		);

		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Points per opened day",
				desc:
					"What a plain task accrues each day you open its note. At 0.2 a task " +
					"reaches grey after 5 days and red after 50.",
				getValue: () => score().baseDailyRate,
				setValue: (value) => {
					score().baseDailyRate = value;
					save();
				},
				min: 0.01,
				max: 5,
				debounceMs: 500,
			})
		);

		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Important multiplier",
				desc: "How much faster an important task accrues.",
				getValue: () => score().importantMultiplier,
				setValue: (value) => {
					score().importantMultiplier = value;
					save();
				},
				min: 1,
				max: 20,
				debounceMs: 500,
			})
		);

		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Urgent multiplier",
				desc: "How much faster an urgent task accrues.",
				getValue: () => score().urgentMultiplier,
				setValue: (value) => {
					score().urgentMultiplier = value;
					save();
				},
				min: 1,
				max: 40,
				debounceMs: 500,
			})
		);
	});

	// Bonuses ----------------------------------------------------------------
	createSettingGroup(container, { heading: "Bonuses" }, (group) => {
		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Scheduled bonus",
				desc: "Flat points once the scheduled date has arrived. 10 reaches red on its own.",
				getValue: () => score().dueTodayBonus,
				setValue: (value) => {
					score().dueTodayBonus = value;
					save();
				},
				min: 0,
				max: 50,
				debounceMs: 500,
			})
		);

		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Due date bonus",
				desc: "Flat points on and after the due date.",
				getValue: () => score().deadlineBonus,
				setValue: (value) => {
					score().deadlineBonus = value;
					save();
				},
				min: 0,
				max: 50,
				debounceMs: 500,
			})
		);

		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Quick win threshold (minutes)",
				desc: "A time estimate at or below this earns the full quick-win bonus.",
				getValue: () => score().quickWinMinutes,
				setValue: (value) => {
					score().quickWinMinutes = value;
					save();
				},
				min: 1,
				max: 480,
				debounceMs: 500,
			})
		);

		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Maximum quick-win bonus",
				desc: "Largest bonus a short time estimate can contribute. It falls to zero at four times the threshold.",
				getValue: () => score().maxDurationBonus,
				setValue: (value) => {
					score().maxDurationBonus = value;
					save();
				},
				min: 0,
				max: 10,
				debounceMs: 500,
			})
		);

		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Blocking transfer",
				desc:
					"Share of a blocked task's score that flows to whatever blocks it, so a " +
					"small task holding up important work rises. 0 disables it.",
				getValue: () => score().blockingTransfer,
				setValue: (value) => {
					score().blockingTransfer = value;
					save();
				},
				min: 0,
				max: 1,
				debounceMs: 500,
			})
		);
	});

	// Priority mapping -------------------------------------------------------
	createSettingGroup(
		container,
		{
			heading: "Priority mapping",
			description: "Which of your priority values count as important or urgent.",
		},
		(group) => {
			group.addSetting((setting) =>
				configureTextSetting(setting, {
					name: "Important priorities",
					desc: "Comma-separated priority values treated as important.",
					placeholder: "high",
					getValue: () => score().importantPriorities.join(", "),
					setValue: (value) => {
						score().importantPriorities = parseList(value);
						save();
					},
					debounceMs: 500,
				})
			);

			group.addSetting((setting) =>
				configureTextSetting(setting, {
					name: "Urgent priorities",
					desc: "Comma-separated priority values treated as urgent.",
					placeholder: "urgent",
					getValue: () => score().urgentPriorities.join(", "),
					setValue: (value) => {
						score().urgentPriorities = parseList(value);
						save();
					},
					debounceMs: 500,
				})
			);
		}
	);

	// Bases integration ------------------------------------------------------
	createSettingGroup(
		container,
		{
			heading: "Bases integration",
			description:
				"Write the score tier into task frontmatter so Bases views can sort, " +
				"filter and group by it.",
		},
		(group) => {
			group.addSetting((setting) =>
				configureToggleSetting(setting, {
					name: "Write tier to frontmatter",
					desc:
						"Only writes when a task crosses a tier boundary, so notes are not " +
						"rewritten every day.",
					getValue: () => score().writeBackOnTierChange,
					setValue: (value) => {
						score().writeBackOnTierChange = value;
						save();
					},
				})
			);

			group.addSetting((setting) =>
				configureTextSetting(setting, {
					name: "Property name",
					desc: "The frontmatter property the tier is written to.",
					placeholder: "taskScoreTier",
					getValue: () => score().writeBackProperty,
					setValue: (value) => {
						score().writeBackProperty = value.trim();
						save();
					},
					debounceMs: 500,
				})
			);
		}
	);

	// Maintenance ------------------------------------------------------------
	createSettingGroup(container, { heading: "Attention log" }, (group) => {
		group.addSetting((setting) =>
			configureNumberSetting(setting, {
				name: "Retention window (days)",
				desc: "Opens older than this stop counting and are pruned from the log.",
				getValue: () => score().attentionWindowDays,
				setValue: (value) => {
					score().attentionWindowDays = value;
					save();
				},
				min: 7,
				max: 3650,
				debounceMs: 500,
			})
		);

		group.addSetting((setting) =>
			configureButtonSetting(setting, {
				name: "Reset attention history",
				desc: "Deletes every recorded note open. This cannot be undone — the history cannot be rebuilt.",
				buttonText: "Reset",
				onClick: async () => {
					await plugin.taskScoreService?.reset();
					new Notice("Task Score: attention history cleared.");
					renderTaskScoreTab(container, plugin, save);
				},
			})
		);
	});
}
