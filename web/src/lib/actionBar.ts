// 房間頁的主要操作列（lobby 的搜尋／準備、候選清單下的房主動作）：內容很長時黏在畫面底部，
// 不必捲到最後才按得到；捲到底時回到原位，不蓋住最後一列。必須是階段區塊的直接子元素，黏住的範圍才是整個階段。
// -mx-4／px-4 讓底色撐滿 main 的內距；半透明底同 RoomHeader；pb 讓開 iPhone 的 home indicator。
// 手機橫放（視窗矮）時不黏：房主初選的操作列約 160px，黏著會把清單擠到只剩一兩行。
// 掛 data-action-bar 的元素會讓 index.css 替 html 留 scroll-padding，Tab 的焦點才不會被它蓋住
export const ACTION_BAR = 'sticky bottom-0 z-10 -mx-4 bg-canvas/85 px-4 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))] backdrop-blur [@media(max-height:500px)]:static'
