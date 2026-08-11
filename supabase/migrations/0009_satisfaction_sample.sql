-- P3：滿足度樣本（spec §5）。decided 當下把「中選餐廳對每位成員的偏好命中分」記進
-- 同席紀錄；EMA 讀取時 rating（餐後評分）優先於 pref_hit ——
-- 晚到的評分自然取代當初的估計值，不需要回頭改 EMA。
-- 空偏好成員寫 null（D22：無訊號不混充中性訊號；rating 才是他們的真訊號來源）。
alter table public.dining_history
  add column pref_hit double precision check (pref_hit between 0 and 1);
