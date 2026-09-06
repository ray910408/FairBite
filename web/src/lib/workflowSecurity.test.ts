/// <reference types="node" />
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { expect, it } from 'vitest'

it('pins every external workflow action to an immutable commit', () => {
  const directory = fileURLToPath(new URL('../../../.github/workflows/', import.meta.url))
  for (const file of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
    const source = readFileSync(`${directory}/${file}`, 'utf8')
    const actions = [...source.matchAll(/^\s*(?:-\s*)?uses:\s*(\S+)/gm)].map(match => match[1])
    expect(actions.length, file).toBeGreaterThan(0)
    for (const action of actions) expect(action, `${file}: ${action}`).toMatch(/^[\w-]+\/[\w./-]+@[a-f0-9]{40}$/)
  }
})
