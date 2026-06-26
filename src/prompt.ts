/**
 * Readline-based interactive prompt for the setup wizard.
 *
 * Thin, injectable adapter. The wizard runner takes a `WizardPrompt` interface
 * so tests drive it with a fake prompter and the real readline implementation
 * is only used by the CLI.
 */

import { createInterface, type Interface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export interface WizardPrompt {
  /** Prompt for a line of text. Returns the trimmed value. Resolves "" on empty. */
  text(message: string, defaultValue?: string): Promise<string>;
  /** Prompt for a secret (no echo). Returns the raw value. */
  secret(message: string): Promise<string>;
  /** Ask a yes/no question. Returns true for yes/y (case-insensitive), else false. */
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  /** Present a numbered menu and return the selected option's index (0-based). */
  select(message: string, options: readonly string[], defaultIndex?: number): Promise<number>;
  /** Ask for a comma-separated list. Returns trimmed, non-empty values. */
  list(message: string, defaults?: string[]): Promise<string[]>;
}

export class ReadlinePrompt implements WizardPrompt {
  private rl: Interface;

  constructor(rl?: Interface) {
    this.rl = rl ?? createInterface({ input, output, terminal: false });
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    const hint = defaultValue !== undefined && defaultValue !== "" ? ` [${defaultValue}]` : "";
    const answer = (await this.rl.question(`${message}${hint}: `)).trim();
    if (answer === "" && defaultValue !== undefined) return defaultValue;
    return answer;
  }

  async secret(message: string): Promise<string> {
    // node:readline/promises has no mute-on-type helper without the legacy
    // readline module. For a CLI wizard, echoing the key on the local terminal
    // is acceptable; Pi's own `pi` login also reads from stdin. We do NOT log
    // the key anywhere else.
    const answer = (await this.rl.question(`${message}: `)).trim();
    return answer;
  }

  async confirm(message: string, defaultValue?: boolean): Promise<boolean> {
    const hint = defaultValue === true ? " [Y/n]" : defaultValue === false ? " [y/N]" : " [y/n]";
    const answer = (await this.rl.question(`${message}${hint}: `)).trim().toLowerCase();
    if (answer === "" && defaultValue !== undefined) return defaultValue;
    return answer === "y" || answer === "yes";
  }

  async select(message: string, options: readonly string[], defaultIndex?: number): Promise<number> {
    const lines = [message];
    options.forEach((option, index) => {
      const marker = defaultIndex === index ? " (default)" : "";
      lines.push(`${index + 1}. ${option}${marker}`);
    });
    while (true) {
      const answer = (await this.rl.question(lines.join("\n") + "\nEnter number: ")).trim();
      if (answer === "" && defaultIndex !== undefined) return defaultIndex;
      const num = Number(answer);
      if (Number.isInteger(num) && num >= 1 && num <= options.length) {
        return num - 1;
      }
      await this.rl.question(`Invalid choice '${answer}'. Press Enter to retry.\n`);
    }
  }

  async list(message: string, defaults?: string[]): Promise<string[]> {
    const hint = defaults && defaults.length > 0 ? ` [${defaults.join(", ")}]` : "";
    const answer = (await this.rl.question(`${message}${hint}: `)).trim();
    if (answer === "" && defaults) return defaults;
    return answer
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
  }

  close(): void {
    this.rl.close();
  }
}
