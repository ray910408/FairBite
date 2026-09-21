import { useEffect, useRef, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import { leaveRooms } from '../lib/api'
import { applyDefaultPrefs } from '../lib/defaultPrefs'
import { normalizeInviteCode } from '../lib/invite'
import { fetchLeaveRooms } from '../lib/roomMembership'
import { supabase } from '../lib/supabase'
import { Alert, Logo, Spinner } from '../components/icons'
import { LeaveConfirm, LeaveRoomsBody } from '../components/LeaveConfirm'
import type { LeaveTarget } from '../lib/roomMembership'

type InviteRow = { room_id: string; status: string; is_member: boolean }

export function validGuestNickname(value: string) {
  const trimmed = value.trim()
  return trimmed.length > 0 && [...trimmed].length <= 80
}

export default function JoinPage() {
  const nav = useNavigate()
  const { code: rawCode = '' } = useParams()
  const code = normalizeInviteCode(rawCode)
  const [nickname, setNickname] = useState('')
  const [needsNickname, setNeedsNickname] = useState(false)
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null)
  const [busy, setBusy] = useState(true)
  const [error, setError] = useState('')
  const inviteGeneration = useRef(0)

  async function joinResolvedRoom(row: InviteRow, generation: number) {
    if (generation !== inviteGeneration.current) return
    if (row.is_member) {
      nav(`/room/${row.room_id}`, { replace: true })
      return
    }
    const memberships = await fetchLeaveRooms()
    if (generation !== inviteGeneration.current) return
    if (memberships === null) {
      setError('目前無法確認你的房間狀態，請稍後再試')
      return
    }
    if (memberships.length > 0) {
      setLeaveTarget({ kind: 'rooms', rooms: memberships })
      return
    }
    const { data, error: joinError } = await supabase.rpc('join_room', { p_code: code })
    if (generation !== inviteGeneration.current) return
    if (joinError || !data) setError(joinError?.message?.includes('頻繁')
      ? '嘗試過於頻繁，請稍後再試' : '房間不存在或已開始')
    else {
      await applyDefaultPrefs(data)
      if (generation !== inviteGeneration.current) return
      nav(`/room/${data}`, { replace: true })
    }
  }

  async function resolveInvite(generation = inviteGeneration.current) {
    if (generation !== inviteGeneration.current) return
    setBusy(true)
    setError('')
    try {
      const { data, error: resolveError } = await supabase.rpc('resolve_room_invite', { p_code: code })
      if (generation !== inviteGeneration.current) return
      const row = (data as InviteRow[] | null)?.[0]
      if (resolveError || !row) setError(resolveError?.message?.includes('頻繁')
        ? '嘗試過於頻繁，請稍後再試' : '房間不存在或已開始')
      else await joinResolvedRoom(row, generation)
    } catch {
      if (generation === inviteGeneration.current) setError('目前無法確認邀請，請檢查網路後再試')
    } finally {
      if (generation === inviteGeneration.current) setBusy(false)
    }
  }

  useEffect(() => {
    const generation = ++inviteGeneration.current
    setBusy(true)
    setError('')
    setNeedsNickname(false)
    setLeaveTarget(null)
    void supabase.auth.getSession().then(({ data }) => {
      if (generation !== inviteGeneration.current) return
      if (data.session) void resolveInvite(generation)
      else {
        setNeedsNickname(true)
        setBusy(false)
      }
    }).catch(() => {
      if (generation !== inviteGeneration.current) return
      setError('目前無法確認登入狀態，請稍後再試')
      setBusy(false)
    })
    return () => { inviteGeneration.current = generation + 1 }
    // Each route generation owns its async work, including guest and departure actions.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code])

  async function continueAsGuest(e: React.FormEvent) {
    e.preventDefault()
    const generation = inviteGeneration.current
    const displayName = nickname.trim()
    if (!validGuestNickname(displayName)) return
    setBusy(true)
    setError('')
    try {
      const { error: signInError } = await supabase.auth.signInAnonymously({
        options: { data: { display_name: displayName } },
      })
      if (signInError) throw signInError
    } catch {
      if (generation !== inviteGeneration.current) return
      setError('訪客登入失敗，請稍後再試')
      setBusy(false)
      return
    }
    if (generation !== inviteGeneration.current) return
    setNeedsNickname(false)
    await resolveInvite(generation)
  }

  async function confirmLeaveAndJoin() {
    const generation = inviteGeneration.current
    setBusy(true)
    setError('')
    try {
      await leaveRooms()
      if (generation !== inviteGeneration.current) return
      setLeaveTarget(null)
      await resolveInvite(generation)
    } catch {
      if (generation !== inviteGeneration.current) return
      setError('原房間離席未完成；請重新確認房間狀態後再試')
      setBusy(false)
    }
  }

  return (
    <>
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-5 p-5"
      inert={!!leaveTarget}>
      <div className="flex flex-col items-center gap-3 text-center">
        <Logo className="h-14 w-14" />
        <h1 className="text-2xl font-bold">加入房間 {code}</h1>
      </div>

      {busy && !leaveTarget && (
        <div className="flex items-center justify-center gap-2 text-sm text-fg-muted">
          <Spinner className="h-5 w-5" /> 正在確認邀請…
        </div>
      )}

      {needsNickname && (
        <form className="card space-y-4" onSubmit={continueAsGuest}>
          <div className="space-y-1">
            <label className="label" htmlFor="nickname">你的暱稱</label>
            <input id="nickname" className="field" autoComplete="nickname" autoFocus required
              value={nickname} onChange={e => {
                e.target.setCustomValidity(validGuestNickname(e.target.value) || !e.target.value
                  ? '' : '暱稱最多 80 字')
                setNickname(e.target.value)
              }} placeholder="房間裡看到的名字" />
          </div>
          <button className="btn btn-primary w-full" type="submit" disabled={busy}>以訪客身分加入</button>
        </form>
      )}

      {error && (
        <p role="alert" className="banner bg-danger-soft text-danger">
          <Alert className="h-5 w-5 shrink-0" /><span>{error}</span>
        </p>
      )}
      {error && !busy && (
        <button className="btn btn-quiet w-full" type="button" onClick={() => resolveInvite()}>重新嘗試</button>
      )}

    </main>
      {leaveTarget && LeaveConfirm({
        title: '你目前在另一個房間',
        actionsClassName: 'sm:flex-row',
        actions: (
          <>
            {leaveTarget.kind === 'rooms' && leaveTarget.rooms.length > 0 && (
              <button autoFocus className="btn btn-quiet flex-1" type="button"
                onClick={() => nav(`/room/${leaveTarget.rooms[0].id}`, { replace: true })}>取消並回原房</button>
            )}
            <button className="btn btn-primary flex-1" type="button" disabled={busy}
              onClick={confirmLeaveAndJoin}>離開並加入</button>
          </>
        ),
        children: (
          <>
            {error && <p role="alert" className="banner bg-danger-soft text-danger">{error}</p>}
            <p className="text-sm text-fg-muted">加入新房前必須先離開目前房間；不會自動切換或保留兩邊房籍。</p>
            <LeaveRoomsBody target={leaveTarget} />
          </>
        ),
      })}
    </>
  )
}
