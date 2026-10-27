// Run with node view-header.test.cjs [path/to/main.js]. No Obsidian or network needed.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const bundle = fs.readFileSync(process.argv[2] || path.join(__dirname, 'main.js'), 'utf8');
const start = bundle.lastIndexOf('// views/VideoSummaryView.ts\n');
const end = bundle.indexOf('\n// utils/FileProcessor.ts', start);
assert.ok(start >= 0 && end > start, 'Expected the installed VideoSummaryView bundle section');

class Element {
  constructor() {
    this.children = [];
    this.clientWidth = 480;
  }
  empty() {
    this.children = [];
  }
  addClass() {}
  toggleClass() {}
  createDiv() {
    const child = new Element();
    this.children.push(child);
    return child;
  }
}

class ItemView {
  constructor() {
    this.headerEl = new Element();
    this.contentEl = new Element();
    this.containerEl = { children: [this.headerEl, this.contentEl] };
    this.app = {
      workspace: {
        on() {
          return {};
        },
      },
    };
  }
  registerEvent() {}
  async open() {
    this.load();
    await this.onOpen();
  }
  load() {
    this._loaded = true;
  }
}

const context = {
  [bundle.match(/var VideoSummaryView = class extends (import_obsidian\d*)\.ItemView/)[1]]: {
    ItemView,
  },
  ResizeObserver: class {
    observe() {}
    disconnect() {}
  },
  window: {
    setInterval() {
      return 1;
    },
    clearInterval() {},
  },
  disconnectLibraryCoverObserver() {},
};
vm.createContext(context);
vm.runInContext(bundle.slice(start, end), context);

async function check(withHoverEditor) {
  // Mirrors Hover Editor's ItemView.load hook: it needs the native title bar
  // before VideoSummaryView.onOpen has run, including after closing/reopening.
  ItemView.prototype.load = function () {
    if (withHoverEditor) this.headerEl.createDiv('view-header-icon');
    this._loaded = true;
  };
  const plugin = {
    settings: {},
    jobs: { subscribe: () => () => {} },
    noteIndex: { subscribe: () => () => {} },
  };
  const view = new context.VideoSummaryView({}, plugin);
  const nativeHeader = view.containerEl.children[0];
  assert.equal(view.headerEl, nativeHeader, 'Constructor must preserve Obsidian headerEl');
  let renders = 0;
  view.renderAll = () => {
    renders += 1;
  };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await view.open();
    assert.equal(view.headerEl, nativeHeader, 'onOpen must preserve the native title bar');
    assert.equal(view.contentEl.children.length, 2, 'Action area and panel must be created');
    await view.onClose();
  }
  assert.equal(renders, 2);
}

(async () => {
  await check(false);
  await check(true);
  console.log('PASS: native header preserved; view opens/reopens with and without Hover Editor');
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
