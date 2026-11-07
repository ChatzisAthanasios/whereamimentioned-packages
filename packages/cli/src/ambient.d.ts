/**
 * Ambient declarations for dependencies that ship no types.
 *
 * `update-notifier@7` publishes no `types` entry and no `@types/update-notifier` matches it, so
 * the slice the CLI uses (10-CLI section 11.2) is declared here: construct with `pkg` and an
 * interval, read `update` from the previous background check. Nothing else is called.
 */
declare module "update-notifier" {
  export interface UpdateInfo {
    latest: string;
    current: string;
    type: string;
    name: string;
  }

  export interface UpdateNotifierOptions {
    pkg: { name: string; version: string };
    updateCheckInterval?: number;
    shouldNotifyInNpmScript?: boolean;
    distTag?: string;
  }

  export interface UpdateNotifier {
    update?: UpdateInfo;
    notify(options?: Record<string, unknown>): void;
    fetchInfo(): Promise<UpdateInfo>;
  }

  export default function updateNotifier(options: UpdateNotifierOptions): UpdateNotifier;
}
