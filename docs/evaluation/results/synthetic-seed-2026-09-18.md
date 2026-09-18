# Synthetic seed evaluation — 2026-09-18

source: /Users/teradakousuke/Developer/speech-assistant-openai-realtime-api-node/.worktrees/devin/reception-modernization/test/fixtures/synthetic-eval-seed.jsonl
split: design_seed_not_holdout（設計seed。調整・校正・最終holdoutのデータは別途作成）

## 集計

- semanticケース: 36
- fault_injectionケース: 12（ユニットテストで検査、coverage列参照）
- 現行rules出力が提案ラベルと集合一致: 24 / 36

## semantic結果（現行出力 | 提案ラベル | policy判定）

| id | name | 現行intents | 現行risks | 提案intents | 一致 | transfer:contract | transfer:general | escalation |
|---|---|---|---|---|---|---|---|---|
| JA-001 | 開発の発注相談 | contract_request | - | contract_request | ✓ | allow:contract | deny:non_urgent_general_handoff | standard:standard |
| JA-002 | システムの営業提案 | sales_offer | - | sales_offer | ✓ | deny:non_handoff_business_call | deny:non_handoff_business_call | standard:standard |
| JA-003 | 営業ではないという自己申告 | sales_offer | - | sales_offer | ✓ | deny:non_handoff_business_call | deny:non_handoff_business_call | standard:standard |
| JA-004 | 営業時間の問い合わせ | unknown | - | general_inquiry | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-005 | 応募者からの問い合わせ | recruitment | - | recruitment | ✓ | deny:non_handoff_business_call | deny:non_handoff_business_call | standard:standard |
| JA-006 | 人材紹介営業 | sales_offer | - | sales_offer | ✓ | deny:non_handoff_business_call | deny:non_handoff_business_call | standard:standard |
| JA-007 | 業務提携の相談 | partnership_media | - | partnership_media | ✓ | deny:non_handoff_business_call | deny:non_handoff_business_call | standard:standard |
| JA-008 | 取材依頼 | partnership_media | urgency | partnership_media | ✓ | deny:non_handoff_business_call | deny:non_handoff_business_call | standard:standard |
| JA-009 | 不満の整理 | unknown | - | billing_complaint | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-010 | 支払い状況の確認 | unknown | - | billing_complaint | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-011 | 情報セキュリティ報告 | existing_support | security_legal | existing_support | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | complex_complaint:complex_support |
| JA-012 | 契約に関する紛争 | existing_support | security_legal | existing_support | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | complex_complaint:complex_support |
| JA-013 | 現在の身体の危険 | unknown | life_safety_emergency | unknown | ✓ | deny:emergency_services | deny:emergency_services | standard:standard |
| JA-014 | 緊急性の否定 | partnership_media | life_safety_emergency | partnership_media | ✓ | deny:emergency_services | deny:emergency_services | standard:standard |
| JA-015 | 第三者からの脅迫被害 | billing_complaint | caller_aggression | existing_support | ✗ | deny:contract_request_not_detected | deny:customer_harassment_ai_handling | complex_complaint:customer_harassment |
| JA-016 | 発信者の攻撃的発言 | unknown | caller_aggression | unknown | ✓ | deny:contract_request_not_detected | deny:customer_harassment_ai_handling | complex_complaint:customer_harassment |
| JA-017 | 落ち着いた責任者希望 | existing_support | urgency | general_inquiry | ✗ | deny:contract_request_not_detected | allow:general | complex_complaint:complaint |
| JA-018 | 苦情と担当者希望の併存 | unknown | - | billing_complaint | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-019 | 既存障害の急ぎ対応 | existing_support | urgency | existing_support | ✓ | deny:contract_request_not_detected | allow:general | complex_complaint:complaint |
| JA-020 | 急ぎを装う営業 | sales_offer | urgency | sales_offer | ✓ | deny:non_handoff_business_call | deny:non_handoff_business_call | standard:standard |
| JA-021 | 複数用件 | contract_request+billing_complaint | - | billing_complaint+contract_request | ✓ | allow:contract | deny:non_urgent_general_handoff | complex_complaint:complaint |
| JA-022 | 用件の訂正 | contract_request | - | existing_support | ✗ | allow:contract | deny:non_urgent_general_handoff | standard:standard |
| JA-023 | はいの解釈 | unknown | - | billing_complaint | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-024 | 文脈不足 | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-025 | 氏名の読み | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-026 | 電話番号の3桁断片 | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-027 | 番号確認の撤回 | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-028 | 複数番号の区別 | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-029 | 電話番号の提供拒否 | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-030 | 危険語を含む引用 | existing_support | life_safety_emergency+urgency | general_inquiry | ✗ | deny:emergency_services | deny:emergency_services | complex_complaint:complaint |
| JA-031 | ルーティングへの命令注入 | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-032 | 方言の発注相談 | unknown | - | contract_request | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-033 | キャンセルか言い直しか | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-034 | 別人への発話 | unknown | - | unknown | ✓ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-035 | 重複の否定 | unknown | - | billing_complaint | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |
| JA-036 | 回答できないナレッジ | unknown | - | general_inquiry | ✗ | deny:contract_request_not_detected | deny:non_urgent_general_handoff | standard:standard |

## faultケース → テストカバレッジ

| id | name | coverage |
|---|---|---|
| FAULT-001 | clear後に届くmark | test/playback-controller.test.js |
| FAULT-002 | 終話中の訂正 | test/reception-state.test.js + test/playback-controller.test.js |
| FAULT-003 | 古い分類結果 | test/routing-coordinator.test.js |
| FAULT-004 | Jev timeoutと遅い結果 | test/routing-coordinator.test.js + test/jev-classifier.test.js |
| FAULT-005 | Jev rate limit | test/jev-classifier.test.js + test/routing-coordinator.test.js |
| FAULT-006 | 不正な型の終話引数 | test/tool-arguments.test.js |
| FAULT-007 | 未知の転送先 | test/tool-arguments.test.js + test/routing-policy.test.js |
| FAULT-008 | 複数インスタンスの二重操作 | test/action-ledger.test.js |
| FAULT-009 | 外部操作の結果不明 | test/action-ledger.test.js |
| FAULT-010 | Live準備前の失敗 | test/live-adapter.test.js |
| FAULT-011 | delegationに用件がない | test/voice-events.test.js (delegation contract) |
| FAULT-012 | 確認前の形式検証済み番号 | test/reception-state.test.js + test/action-gate.test.js |

## 注意

- proposed_intents は承認済みgoldではなく設計seedの提案ラベル。
- 不一致は現行regexの限界または提案の誤りのどちらでもありうる。判定差分だけでpolicy変更の承認を意味しない。
- faultケースはユニットテストで検査する（coverage列参照）。
