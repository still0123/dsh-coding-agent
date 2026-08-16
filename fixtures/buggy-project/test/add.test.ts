import assert from 'node:assert/strict'
import test from 'node:test'
import { add } from '../src/add.ts'

test('adds two numbers', () => {
  assert.equal(add(2, 2), 4, 'expected 4, received 3')
})
