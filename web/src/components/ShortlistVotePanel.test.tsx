import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import ShortlistVotePanel from './ShortlistVotePanel'

const props = {
  wantShortlist: true,
  yesCount: 2,
  memberCount: 4,
  busy: false,
  onVote: () => {},
}

it('shows the shortlist checkbox, the pick rule and a strict-majority tally', () => {
  const html = renderToStaticMarkup(<ShortlistVotePanel {...props} />)
  expect(html).toContain('候選太多？先初選再投票')
  expect(html).toContain('每人圈 3 到 5 家，沒人圈的店不進轉盤')
  expect(html).toContain('我想先初選')
  expect(html).toContain('aria-checked="true"')
  // 4 人要 3 票：2 票剛好一半不算過半
  expect(html).toContain('目前 2/4 票，需 3 票才會進入初選')
  expect(html).not.toContain('disabled=""')
})

it('disables the checkbox while a vote is in flight', () => {
  const html = renderToStaticMarkup(<ShortlistVotePanel {...props} wantShortlist={false} busy />)
  expect(html).toContain('aria-checked="false"')
  expect(html).toContain('disabled=""')
})
