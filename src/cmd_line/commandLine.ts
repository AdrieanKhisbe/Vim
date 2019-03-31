import * as parser from './parser';
import * as vscode from 'vscode';
import { CommandLineHistory } from '../history/historyFile';
import { ModeName } from './../mode/mode';
import { Logger } from '../util/logger';
import { StatusBar } from '../statusBar';
import { VimError, ErrorCode } from '../error';
import { VimState } from '../state/vimState';
import { configuration } from '../configuration/configuration';

class CommandItem implements vscode.QuickPickItem {
  public label: string;
  public description?: string;
  public type: 'input' | 'history';
  constructor(type: 'input' | 'history', label: string, description?: string) {
    this.type = type;
    this.label = label;
    this.description = description;
  }
}

const VIM_HISTORY_KEY = 'VIM_HISTORY_KEY';

class CommandLine {
  private _history: CommandLineHistory;
  private readonly _logger = Logger.get('CommandLine');
  private _memo: vscode.Memento | undefined;
  /**
   *  Index used for navigating commandline history with <up> and <down>
   */
  private _commandLineHistoryIndex: number = 0;

  public get commandlineHistoryIndex(): number {
    return this._commandLineHistoryIndex;
  }

  public set commandlineHistoryIndex(index: number) {
    this._commandLineHistoryIndex = index;
  }

  public setMemo(memo: vscode.Memento) {
    this._memo = memo;
  }

  public get historyEntries() {
    return this._history.get();
  }

  public previousMode = ModeName.Normal;

  constructor() {
    this._history = new CommandLineHistory();
  }

  public async load(): Promise<void> {
    return this._history.load();
  }

  public async Run(command: string, vimState: VimState): Promise<void> {
    if (!command || command.length === 0) {
      return;
    }

    if (command && command[0] === ':') {
      command = command.slice(1);
    }

    if (command === 'help') {
      StatusBar.Set(`:help Not supported.`, vimState.currentMode, vimState.isRecordingMacro, true);
      return;
    }

    this._history.add(command);
    this._commandLineHistoryIndex = this._history.get().length;

    try {
      const cmd = parser.parse(command);
      const useNeovim = configuration.enableNeovim && cmd.command && cmd.command.neovimCapable;

      if (useNeovim) {
        const statusBarText = await vimState.nvim.run(vimState, command);
        StatusBar.Set(statusBarText, vimState.currentMode, vimState.isRecordingMacro, true);
      } else {
        await cmd.execute(vimState.editor, vimState);
      }
    } catch (e) {
      if (e instanceof VimError) {
        if (e.code === ErrorCode.E492 && configuration.enableNeovim) {
          await vimState.nvim.run(vimState, command);
        } else {
          StatusBar.Set(
            `${e.toString()}. ${command}`,
            vimState.currentMode,
            vimState.isRecordingMacro,
            true
          );
        }
      } else {
        this._logger.error(`Error executing cmd=${command}. err=${e}.`);
      }
    }
  }

  public async PromptAndRun(initialText: string, vimState: VimState): Promise<void> {
    if (!vscode.window.activeTextEditor) {
      this._logger.debug('No active document');
      return;
    }
    const newMethod = true;
    const cmd = newMethod
      ? await this.promptForCommand(initialText)
      : await vscode.window.showInputBox(this.getInputBoxOptions(initialText));
    await this.Run(cmd!, vimState);
  }
  private async promptForCommand(text: string): Promise<string | undefined> {
    const disposables: vscode.Disposable[] = [];
    try {
      return await new Promise<string | undefined>((resolve, reject) => {
        const input = vscode.window.createQuickPick<CommandItem>();
        input.placeholder = 'Vim command Line';
        input.items = text ? [new CommandItem('input', text, '(input')] : [];

        const updateQuickPick = (value?: string): void => {
          if (!value) {
            if (input.items[0] && input.items[0].type === 'input') {
              input.items = input.items.slice(1);
            }
            return;
          }
          if (input.items[0] && input.items[0].type === 'input') {
            input.items = [new CommandItem('input', value, '(input)')].concat(input.items.slice(1));
          } else {
            input.items = [new CommandItem('input', value, '(input)')].concat(input.items);
          }
          // §todo: add autocomplete suggestions
        };

        disposables.push(
          input.onDidChangeValue(updateQuickPick),
          input.onDidChangeSelection((items: CommandItem[]) => {
            const item = items[0];
            if (item.type === 'history') {
              resolve(item.label);
              input.hide();
              // do not record new input in history
              // §todo : maybe reorder
            } else if (item.type === 'input') {
              resolve(item.label);
              input.hide();
              // record new input in history
              if (!item.label.startsWith(' ') && this._memo) {
                const currentHistory: string[] = this._memo.get(VIM_HISTORY_KEY, []);
                currentHistory.unshift(item.label);
                this._memo.update(VIM_HISTORY_KEY, currentHistory);
              }
            }
          }),
          input.onDidHide(() => {
            resolve(undefined);
            input.dispose();
          })
        );
        input.show();
        const historyItems: CommandItem[] = !this._memo
          ? []
          : this._memo
              .get(VIM_HISTORY_KEY, [])
              .map(
                (cmd: string, index: number) =>
                  new CommandItem('history', cmd, `(history item ${index})`)
              );
        input.items = input.items.concat(historyItems);
      });
    } finally {
      disposables.forEach(d => d.dispose());
    }
  }

  private getInputBoxOptions(text: string): vscode.InputBoxOptions {
    return {
      prompt: 'Vim command line',
      value: text,
      ignoreFocusOut: false,
      valueSelection: [text.length, text.length],
    };
  }

  public async ShowHistory(initialText: string, vimState: VimState): Promise<string | undefined> {
    if (!vscode.window.activeTextEditor) {
      this._logger.debug('No active document.');
      return '';
    }

    this._history.add(initialText);

    let cmd = await vscode.window.showQuickPick(
      this._history
        .get()
        .slice()
        .reverse(),
      {
        placeHolder: 'Vim command history',
        ignoreFocusOut: false,
      }
    );

    return cmd;
  }
}

export const commandLine = new CommandLine();
