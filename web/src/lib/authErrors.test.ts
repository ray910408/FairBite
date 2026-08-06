// Regression: ISSUE-001 — auth 錯誤訊息透傳英文原文
// Found by /qa on 2026-08-06
// Report: .gstack/qa-reports/qa-report-localhost-5173-2026-08-06.md
import { describe, expect, it } from 'vitest'
import { authErrorMessage } from './authErrors'

const err = (code: string | undefined, message = 'raw english') => ({ code, message })

describe('authErrorMessage', () => {
  it('weak_password 轉中文', () =>
    expect(authErrorMessage(err('weak_password'))).toBe('密碼至少需要 6 碼'))
  it('invalid_credentials 轉中文', () =>
    expect(authErrorMessage(err('invalid_credentials'))).toBe('Email 或密碼錯誤'))
  it('user_already_exists 轉中文', () =>
    expect(authErrorMessage(err('user_already_exists'))).toBe('這個 Email 已經註冊過了'))
  it('email_exists 轉中文', () =>
    expect(authErrorMessage(err('email_exists'))).toBe('這個 Email 已經註冊過了'))
  it('email_address_invalid 轉中文', () =>
    expect(authErrorMessage(err('email_address_invalid'))).toBe('Email 格式不正確'))
  it('over_request_rate_limit 轉中文', () =>
    expect(authErrorMessage(err('over_request_rate_limit'))).toBe('嘗試次數過多，請稍後再試'))
  it('over_email_send_rate_limit 轉中文', () =>
    expect(authErrorMessage(err('over_email_send_rate_limit'))).toBe('驗證信寄送過於頻繁，請稍後再試'))
  it('signup_disabled 轉中文', () =>
    expect(authErrorMessage(err('signup_disabled'))).toBe('目前未開放註冊'))
  it('email_not_confirmed 轉中文', () =>
    expect(authErrorMessage(err('email_not_confirmed'))).toBe('Email 尚未驗證，請先完成信箱驗證'))
  it('沒有 code 且訊息像連線失敗時提示網路', () =>
    expect(authErrorMessage(err(undefined, 'Failed to fetch'))).toBe('連線失敗，請檢查網路後再試'))
  it('有 code 時不會被連線失敗訊息蓋掉', () =>
    expect(authErrorMessage(err('invalid_credentials', 'network error'))).toBe('Email 或密碼錯誤'))
  it('未知 code 用預設訊息', () =>
    expect(authErrorMessage(err('mystery_code'))).toBe('操作失敗，請稍後再試'))
  it('沒有 code 用預設訊息', () =>
    expect(authErrorMessage(err(undefined))).toBe('操作失敗，請稍後再試'))
})
