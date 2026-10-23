use serde_json::{json, Value};

use crate::plugins::auth::require_user;
use crate::services::{resolve_group, send_to, SendPayload};
use crate::state::{handler, Registry, SharedState};
use crate::store;
use crate::util;

const MAX_AMOUNT: i64 = 200_000_000;
const MAX_MESSAGE: usize = 50;
const MAX_COUNT: i64 = 200;
const MAX_MEMBERS: usize = 200;
const MAX_DESCRIPTION: usize = 50;
const DEFAULT_MESSAGE: &str = "恭喜发财，大吉大利";
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

fn amount_of(params: &Value, key: &str, label: &str) -> Result<i64, String> {
    let Some(raw) = params.get(key) else {
        return Err(format!("{label}必须是整数（单位：分）"));
    };
    if let Some(num) = raw.as_i64() {
        return Ok(num);
    }
    if let Some(num) = raw.as_f64() {
        if num.is_finite() && num.fract() == 0.0 && num.abs() < 9.0e15 {
            return Ok(num as i64);
        }
    }
    Err(format!("{label}必须是整数（单位：分）"))
}

fn even_share(remaining: i64, left: i64) -> i64 {
    let base = remaining / left.max(1);
    remaining - base * (left - 1).max(0)
}

fn lucky_share(remaining: i64, left: i64) -> i64 {
    if left <= 1 {
        return remaining;
    }
    let min = 1;
    let max = (remaining - min * (left - 1)) / left;
    if max <= min {
        return min;
    }
    min + (rand::random::<u64>() % (max - min + 1) as u64) as i64
}

async fn are_friends(state: &SharedState, a: &str, b: &str) -> Result<bool, String> {
    let edges = store::friend_edges(&state.db, a).await?;
    Ok(edges.iter().any(|edge| {
        edge.status == "accepted"
            && ((edge.requester_id == a && edge.addressee_id == b)
                || (edge.requester_id == b && edge.addressee_id == a))
    }))
}

async fn username_of(state: &SharedState, user_id: &str) -> String {
    store::user_by_id(&state.db, user_id)
        .await
        .ok()
        .flatten()
        .map(|user| user.username)
        .unwrap_or_else(|| "已注销用户".to_string())
}

fn money_fields(kind: &str, extra: Value) -> (Option<Value>, Option<Value>, Option<Value>) {
    match kind {
        "redpacket" => (Some(extra), None, None),
        "transfer" => (None, Some(extra), None),
        "aabill" => (None, None, Some(extra)),
        _ => (None, None, None),
    }
}

async fn send_money(
    state: &SharedState,
    me: &crate::hub::AuthUser,
    session: &str,
    content: String,
    kind: &str,
    extra: Value,
) -> Result<Value, String> {
    let (red_packet, transfer, aa_bill) = money_fields(kind, extra);
    send_to(
        state,
        me,
        session,
        SendPayload {
            content,
            quote: None,
            mentions: None,
            kind: kind.to_string(),
            file: None,
            red_packet,
            transfer,
            aa_bill,
            link: None,
        },
    )
    .await
}

fn transfer_json(row: &store::TransferRow, me_id: &str, from_name: &str, to_name: &str) -> Value {
    json!({
        "id": row.id,
        "sessionId": row.session,
        "fromId": row.from_id,
        "toId": row.to_id,
        "amount": row.amount,
        "message": row.message,
        "state": row.state,
        "createdAt": util::iso_from_ms(row.created_at),
        "expiredAt": util::iso_from_ms(row.expired_at),
        "myId": me_id,
        "fromName": from_name,
        "toName": to_name,
        "action": if row.from_id == me_id { "sent" } else { "received" },
    })
}

async fn summarize_transfer(
    state: &SharedState,
    row: &store::TransferRow,
    me_id: &str,
) -> Value {
    let from_name = username_of(state, &row.from_id).await;
    let to_name = username_of(state, &row.to_id).await;
    transfer_json(row, me_id, &from_name, &to_name)
}

async fn packet_json(
    state: &SharedState,
    row: &store::RedPacketRow,
    viewer_id: Option<&str>,
) -> Result<Value, String> {
    let records = store::packet_records(&state.db, &row.id).await?;
    let mine = viewer_id.and_then(|id| {
        records
            .iter()
            .find(|record| record.claimer_id == id)
            .map(|record| record.amount)
    });
    Ok(json!({
        "id": row.id,
        "sessionId": row.session_id,
        "senderId": row.sender_id,
        "type": row.kind,
        "totalAmount": row.total_amount,
        "totalCount": row.total_count,
        "remaining": row.remaining,
        "remainCount": row.remain_count,
        "status": row.status,
        "message": row.message,
        "createdAt": util::iso_from_ms(row.created_at),
        "claimedCount": records.len(),
        "myAmount": mine,
    }))
}

fn p2p_names(session: &str) -> Vec<String> {
    session
        .trim_start_matches("p2p:")
        .split('|')
        .map(|name| name.trim().to_string())
        .filter(|name| !name.is_empty())
        .collect()
}

async fn packet_audience(state: &SharedState, me: &crate::hub::AuthUser, row: &store::RedPacketRow) -> Vec<String> {
    if row.session_id.starts_with("p2p:") {
        let names = p2p_names(&row.session_id);
        let mut ids: Vec<String> = Vec::new();
        for name in names {
            if let Ok(Some(user)) = store::user_by_username(&state.db, &name).await {
                ids.push(user.id);
            }
        }
        return ids;
    }
    let group_id = row.session_id.trim_start_matches("g:");
    if resolve_group(state, me, &format!("g:{group_id}")).await.is_err() {
        return Vec::new();
    }
    store::group_members(&state.db, group_id)
        .await
        .map(|members| members.into_iter().map(|member| member.user_id).collect())
        .unwrap_or_default()
}

async fn can_see_packet(state: &SharedState, me: &crate::hub::AuthUser, row: &store::RedPacketRow) -> bool {
    if row.sender_id == me.id {
        return true;
    }
    if row.session_id.starts_with("g:") {
        let group_id = row.session_id.trim_start_matches("g:");
        return resolve_group(state, me, &format!("g:{group_id}")).await.is_ok();
    }
    p2p_names(&row.session_id).iter().any(|name| name == &me.username)
}

async fn bill_json(state: &SharedState, bill: &store::BillRow, me: &crate::hub::AuthUser) -> Value {
    let payments = store::bill_payments(&state.db, &bill.id).await.unwrap_or_default();
    let creator_name = username_of(state, &bill.creator_id).await;
    let mine = payments
        .iter()
        .find(|payment| payment.payer_id == me.id)
        .map(|payment| payment.amount)
        .unwrap_or(0);
    let share = store::bill_share(bill, &me.id).unwrap_or(0);
    let mut members: Vec<Value> = Vec::new();
    for id in &bill.participant_ids {
        let name = username_of(state, id).await;
        let paid = payments.iter().find(|payment| &payment.payer_id == id);
        members.push(json!({
            "userId": id,
            "username": name,
            "share": store::bill_share(bill, id).unwrap_or(0),
            "paidAmount": paid.map(|payment| payment.amount).unwrap_or(0),
            "paid": paid.is_some(),
        }));
    }
    let payment_rows: Vec<Value> = payments
        .iter()
        .map(|payment| {
            json!({
                "userId": payment.payer_id,
                "amount": payment.amount,
                "paidAt": util::iso_from_ms(payment.paid_at),
            })
        })
        .collect();
    let mut with_names: Vec<Value> = Vec::new();
    for (index, payment) in payments.iter().enumerate() {
        let mut row = payment_rows[index].clone();
        row["username"] = json!(username_of(state, &payment.payer_id).await);
        with_names.push(row);
    }
    json!({
        "bill": {
            "id": bill.id,
            "sessionId": bill.session_id,
            "creatorId": bill.creator_id,
            "description": bill.description,
            "totalAmount": bill.total_amount,
            "settledAmount": bill.settled_amount,
            "participantIds": bill.participant_ids,
            "splitType": bill.split_type,
            "status": bill.status,
            "createdAt": util::iso_from_ms(bill.created_at),
            "deadline": util::iso_from_ms(bill.deadline),
        },
        "share": share,
        "paidAmount": mine,
        "paid": mine > 0,
        "overdue": bill.status == "pending" && bill.deadline <= util::now_ms(),
        "creatorName": creator_name,
        "payments": with_names,
        "members": members,
    })
}

async fn can_see_bill(state: &SharedState, me: &crate::hub::AuthUser, bill: &store::BillRow) -> bool {
    if bill.creator_id == me.id || bill.participant_ids.iter().any(|id| id == &me.id) {
        return true;
    }
    if bill.session_id.starts_with("g:") {
        let group_id = bill.session_id.trim_start_matches("g:");
        return resolve_group(state, me, &format!("g:{group_id}")).await.is_ok();
    }
    p2p_names(&bill.session_id).iter().any(|name| name == &me.username)
}

async fn announce_bill(state: &SharedState, bill: &store::BillRow, me: &crate::hub::AuthUser) {
    let mut targets: Vec<String> = vec![bill.creator_id.clone()];
    if bill.session_id.starts_with("g:") {
        let group_id = bill.session_id.trim_start_matches("g:");
        if let Ok(members) = store::group_members(&state.db, group_id).await {
            targets = members.into_iter().map(|member| member.user_id).collect();
        }
    } else {
        targets.extend(bill.participant_ids.iter().cloned());
        targets.push(me.id.clone());
        let mut unique: Vec<String> = Vec::new();
        for id in targets {
            if !unique.contains(&id) {
                unique.push(id);
            }
        }
        targets = unique;
    }
    state
        .hub
        .emit_to_users(
            &targets,
            "aabill:update",
            json!({ "id": bill.id, "status": bill.status, "settledAmount": bill.settled_amount }),
        )
        .await;
}

pub fn register(registry: &mut Registry) {
    registry.add(
        "wallet.balance",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            let balance = store::wallet_balance(&state.db, &me.id).await?;
            Ok(json!({ "balance": balance }))
        }),
    );

    registry.add(
        "wallet.topup",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let amount = amount_of(&params, "amount", "充值金额")?;
            if amount <= 0 {
                return Err("充值金额必须大于 0".to_string());
            }
            if amount > MAX_AMOUNT {
                return Err("单次充值金额不能超过 2000000 元".to_string());
            }
            let balance = store::wallet_adjust(&state.db, &me.id, amount).await?;
            Ok(json!({ "balance": balance }))
        }),
    );

    registry.add(
        "transfer.send",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let session = util::str_param(&params, "sessionId").trim().to_string();
            let amount = amount_of(&params, "amount", "转账金额")?;
            let message: String = util::str_param(&params, "message")
                .trim()
                .chars()
                .take(MAX_MESSAGE)
                .collect();
            if amount <= 0 {
                return Err("转账金额必须大于 0".to_string());
            }
            if amount > MAX_AMOUNT {
                return Err("单笔转账金额不能超过 2000000 元".to_string());
            }
            if !session.starts_with("p2p:") {
                return Err("转账只能在私聊中进行".to_string());
            }
            let peer_name = util::str_param(&params, "toUsername").trim().to_lowercase();
            if peer_name.is_empty() {
                return Err("缺少收款人".to_string());
            }
            if peer_name == me.username {
                return Err("不能给自己转账".to_string());
            }
            let peer = store::user_by_username(&state.db, &peer_name)
                .await?
                .ok_or_else(|| "对方不存在".to_string())?;
            if !are_friends(&state, &me.id, &peer.id).await? {
                return Err("你们还不是好友，无法转账".to_string());
            }
            let id = util::uuid();
            let created_at = util::now_ms();
            let expired_at = created_at + DAY_MS;
            let created = store::transfer_create(
                &state.db,
                &id,
                &session,
                &me.id,
                &peer.id,
                amount,
                if message.is_empty() { None } else { Some(message.as_str()) },
                expired_at,
            )
            .await?;
            let row = match created {
                store::TransferCreateResult::Ok(row) => row,
                store::TransferCreateResult::Duplicate => return Err("转账发起失败，请重试".to_string()),
                store::TransferCreateResult::Missing => return Err("账户不存在".to_string()),
                store::TransferCreateResult::Insufficient => {
                    return Err("余额不足，请先在个人中心充值或收款".to_string())
                }
            };
            let detail = json!({
                "id": row.id,
                "fromId": row.from_id,
                "toId": row.to_id,
                "amount": row.amount,
                "message": row.message,
                "state": row.state,
                "createdAt": util::iso_from_ms(row.created_at),
                "expiredAt": util::iso_from_ms(row.expired_at),
            });
            let content = if message.is_empty() {
                "转账".to_string()
            } else {
                message.clone()
            };
            let sent = send_money(&state, &me, &session, content, "transfer", detail).await;
            let sent = match sent {
                Ok(value) => value,
                Err(err) => {
                    let _ = store::transfer_cancel_refund(&state.db, &row.id).await;
                    return Err(err);
                }
            };
            let _ = store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "money.transfer.send",
                &format!("{} -> {peer_name} ({})", row.amount, row.id),
            )
            .await;
            let summary = summarize_transfer(&state, &row, &me.id).await;
            Ok(json!({ "transfer": summary, "message": sent }))
        }),
    );

    registry.add(
        "transfer.detail",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let transfer_id = util::str_param(&params, "transferId").trim().to_string();
            if transfer_id.is_empty() {
                return Err("缺少转账 ID".to_string());
            }
            let row = store::transfer_get(&state.db, &transfer_id)
                .await?
                .ok_or_else(|| "转账不存在".to_string())?;
            let visible = row.from_id == me.id
                || row.to_id == me.id
                || are_friends(&state, &me.id, &row.from_id).await?;
            if !visible {
                return Err("你无权查看该转账".to_string());
            }
            Ok(json!({ "transfer": summarize_transfer(&state, &row, &me.id).await }))
        }),
    );

    for (method, accept) in [("transfer.accept", true), ("transfer.reject", false)] {
        registry.add(
            method,
            handler(move |state, conn, params| async move {
                let me = require_user(&conn)?;
                let transfer_id = util::str_param(&params, "transferId").trim().to_string();
                if transfer_id.is_empty() {
                    return Err("缺少转账 ID".to_string());
                }
                let row = store::transfer_get(&state.db, &transfer_id)
                    .await?
                    .ok_or_else(|| "转账不存在".to_string())?;
                if row.to_id != me.id {
                    return Err("只有收款人可以操作".to_string());
                }
                if row.state != "pending" {
                    return Err("该转账已处理过了".to_string());
                }
                if row.expired_at <= util::now_ms() {
                    let _ = store::transfer_expire_if_needed(&state.db).await;
                    return Err("该转账已过期，金额已退回".to_string());
                }
                let settled = store::transfer_settle(&state.db, &transfer_id, accept).await?;
                let fresh = match settled {
                    store::TransferSettleResult::Ok(row) => row,
                    store::TransferSettleResult::Conflict => {
                        return Err("该转账已处理过了".to_string())
                    }
                    store::TransferSettleResult::Missing => return Err("转账不存在".to_string()),
                };
                let _ = store::audit(
                    &state.db,
                    Some(&me.id),
                    &me.username,
                    if accept {
                        "money.transfer.accept"
                    } else {
                        "money.transfer.reject"
                    },
                    &format!("{} ({})", fresh.amount, fresh.id),
                )
                .await;
                state
                    .hub
                    .emit_to_user(
                        &row.from_id,
                        "transfer:update",
                        json!({ "id": fresh.id, "state": fresh.state }),
                    )
                    .await;
                let balance = store::wallet_balance(&state.db, &me.id).await?;
                Ok(json!({
                    "transfer": summarize_transfer(&state, &fresh, &me.id).await,
                    "myBalance": balance,
                }))
            }),
        );
    }

    registry.add(
        "transfer.list",
        handler(|state, conn, _params| async move {
            let me = require_user(&conn)?;
            let rows = store::transfer_list_for_user(&state.db, &me.id).await?;
            let mut list: Vec<Value> = Vec::new();
            for row in &rows {
                list.push(summarize_transfer(&state, row, &me.id).await);
            }
            let balance = store::wallet_balance(&state.db, &me.id).await?;
            Ok(json!({ "transfers": list, "balance": balance }))
        }),
    );

    registry.add(
        "transfer.expire",
        handler(|state, conn, _params| async move {
            require_user(&conn)?;
            let ids = store::transfer_expire_if_needed(&state.db).await?;
            for id in &ids {
                state
                    .hub
                    .broadcast("transfer:update", json!({ "id": id, "state": "refunded" }))
                    .await;
            }
            Ok(json!(ids.len()))
        }),
    );

    registry.add(
        "redpacket.create",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let session = util::str_param(&params, "sessionId").trim().to_string();
            let kind = if util::str_param(&params, "type") == "lucky" {
                "lucky"
            } else {
                "normal"
            };
            let total = amount_of(&params, "totalAmount", "红包金额")?;
            let count = amount_of(&params, "totalCount", "红包个数")?;
            let blessing: String = util::str_param(&params, "message")
                .trim()
                .chars()
                .take(MAX_MESSAGE)
                .collect();
            if total <= 0 {
                return Err("红包金额必须大于 0".to_string());
            }
            if total > MAX_AMOUNT {
                return Err("单个红包金额不能超过 2000000 元".to_string());
            }
            if count <= 0 {
                return Err("红包个数必须大于 0".to_string());
            }
            if count > MAX_COUNT {
                return Err(format!("红包个数不能超过 {MAX_COUNT}"));
            }
            if total < count {
                return Err("金额不足以拆分成这么多个红包".to_string());
            }
            let notify: Vec<String>;
            if session.starts_with("p2p:") {
                let peer_name = session.trim_start_matches("p2p:").trim().to_lowercase();
                let peer = store::user_by_username(&state.db, &peer_name)
                    .await?
                    .ok_or_else(|| "对方不存在".to_string())?;
                if peer.id == me.id {
                    return Err("不能给自己发红包".to_string());
                }
                notify = vec![me.id.clone(), peer.id];
            } else if session.starts_with("g:") {
                let (row, _) = resolve_group(&state, &me, &session).await?;
                notify = store::group_members(&state.db, &row.id)
                    .await?
                    .into_iter()
                    .map(|member| member.user_id)
                    .collect();
            } else {
                return Err("红包只能在私聊或群聊中发送".to_string());
            }
            let _ = notify;
            let id = util::uuid();
            let text = if blessing.is_empty() {
                DEFAULT_MESSAGE.to_string()
            } else {
                blessing.clone()
            };
            let created_at = util::now_ms();
            store::packet_create(
                &state.db,
                &id,
                &session,
                &me.id,
                kind,
                total,
                count,
                &text,
                created_at + DAY_MS,
            )
            .await?;
            let row = store::packet_get(&state.db, &id)
                .await?
                .ok_or_else(|| "红包创建失败".to_string())?;
            let detail = json!({
                "id": row.id,
                "senderId": row.sender_id,
                "sessionId": row.session_id,
                "type": row.kind,
                "totalAmount": row.total_amount,
                "totalCount": row.total_count,
                "status": row.status,
                "remaining": row.remaining,
                "remainCount": row.remain_count,
                "message": row.message,
                "createdAt": util::iso_from_ms(row.created_at),
                "expiredAt": row.expired_at.map(util::iso_from_ms),
            });
            let sent = send_money(&state, &me, &session, text, "redpacket", detail).await?;
            let _ = store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "money.redpacket.create",
                &format!("{total}x{count} {kind} ({id})"),
            )
            .await;
            Ok(json!({
                "packet": packet_json(&state, &row, Some(&me.id)).await?,
                "message": sent,
            }))
        }),
    );

    registry.add(
        "redpacket.claim",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let packet_id = util::str_param(&params, "redPacketId").trim().to_string();
            if packet_id.is_empty() {
                return Err("缺少红包 ID".to_string());
            }
            let row = store::packet_get(&state.db, &packet_id)
                .await?
                .ok_or_else(|| "红包不存在或已被删除".to_string())?;
            if row.sender_id == me.id {
                return Err("不能领取自己发的红包".to_string());
            }
            if !can_see_packet(&state, &me, &row).await {
                return Err("你不在该会话中".to_string());
            }
            if let Some(expired_at) = row.expired_at {
                if expired_at <= util::now_ms() {
                    let _ = store::packet_expire_if_needed(&state.db).await;
                    return Err("红包已过期".to_string());
                }
            }
            if store::packet_claimed_by(&state.db, &packet_id, &me.id)
                .await?
                .is_some()
            {
                return Err("你已经领过这个红包了".to_string());
            }
            let records = store::packet_records(&state.db, &packet_id).await?;
            let left = row.total_count - records.len() as i64;
            let share = if row.kind == "lucky" {
                lucky_share(row.remaining, left)
            } else {
                even_share(row.remaining, left)
            };
            if share <= 0 {
                return Err("手慢了，红包已被抢完".to_string());
            }
            let claimed = store::packet_claim(&state.db, &packet_id, &me.id, share).await?;
            match claimed {
                store::PacketClaimResult::Ok(()) => {}
                store::PacketClaimResult::Duplicate => {
                    return Err("你已经领过这个红包了".to_string())
                }
                store::PacketClaimResult::Missing => return Err("红包不存在".to_string()),
                store::PacketClaimResult::Empty => {
                    return Err("手慢了，红包已被抢完".to_string())
                }
            }
            let _ = store::audit(
                &state.db,
                Some(&me.id),
                &me.username,
                "money.redpacket.claim",
                &format!("{share} <- {packet_id}"),
            )
            .await;
            let audience = packet_audience(&state, &me, &row).await;
            let fresh = store::packet_get(&state.db, &packet_id)
                .await?
                .unwrap_or(row);
            let claim_count = store::packet_records(&state.db, &packet_id).await?.len();
            let payload = json!({
                "id": packet_id,
                "remaining": fresh.remaining,
                "remainCount": fresh.remain_count,
                "status": fresh.status,
                "claimedCount": claim_count,
            });
            state
                .hub
                .emit_to_users(&audience, "redpacket:update", payload)
                .await;
            Ok(json!({
                "amount": share,
                "packet": packet_json(&state, &fresh, Some(&me.id)).await?,
            }))
        }),
    );

    registry.add(
        "redpacket.detail",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let packet_id = util::str_param(&params, "redPacketId").trim().to_string();
            if packet_id.is_empty() {
                return Err("缺少红包 ID".to_string());
            }
            let row = store::packet_get(&state.db, &packet_id)
                .await?
                .ok_or_else(|| "红包不存在或已被删除".to_string())?;
            if !can_see_packet(&state, &me, &row).await {
                return Err("你不在该会话中".to_string());
            }
            let records = store::packet_records(&state.db, &packet_id).await?;
            let best = records
                .iter()
                .max_by_key(|record| record.amount)
                .map(|record| record.claimer_id.clone());
            let mut list: Vec<Value> = Vec::new();
            for record in &records {
                let name = username_of(&state, &record.claimer_id).await;
                list.push(json!({
                    "userId": record.claimer_id,
                    "username": name,
                    "amount": record.amount,
                    "claimedAt": util::iso_from_ms(record.claimed_at),
                    "isMe": record.claimer_id == me.id,
                    "isBest": row.kind == "lucky" && Some(&record.claimer_id) == best.as_ref(),
                }));
            }
            Ok(json!({
                "packet": packet_json(&state, &row, Some(&me.id)).await?,
                "bestClaimerId": best,
                "records": list,
            }))
        }),
    );

    registry.add(
        "redpacket.records",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let packet_id = util::str_param(&params, "redPacketId").trim().to_string();
            if packet_id.is_empty() {
                return Err("缺少红包 ID".to_string());
            }
            let row = store::packet_get(&state.db, &packet_id)
                .await?
                .ok_or_else(|| "红包不存在或已被删除".to_string())?;
            if !can_see_packet(&state, &me, &row).await {
                return Err("你不在该会话中".to_string());
            }
            let records = store::packet_records(&state.db, &packet_id).await?;
            let mut list: Vec<Value> = Vec::new();
            for record in &records {
                list.push(json!({
                    "userId": record.claimer_id,
                    "username": username_of(&state, &record.claimer_id).await,
                    "amount": record.amount,
                    "claimedAt": util::iso_from_ms(record.claimed_at),
                }));
            }
            Ok(json!(list))
        }),
    );

    registry.add(
        "redpacket.expire",
        handler(|state, conn, _params| async move {
            require_user(&conn)?;
            let ids = store::packet_expire_if_needed(&state.db).await?;
            for id in &ids {
                state
                    .hub
                    .broadcast("redpacket:update", json!({ "id": id, "status": "expired" }))
                    .await;
            }
            Ok(json!(ids.len()))
        }),
    );

    registry.add(
        "aa.create",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let session = util::str_param(&params, "sessionId").trim().to_string();
            let total = amount_of(&params, "totalAmount", "账单总额")?;
            if total <= 0 {
                return Err("账单总额必须大于 0".to_string());
            }
            if total > MAX_AMOUNT {
                return Err("账单总额不能超过 2000000 元".to_string());
            }
            let raw_description: String = util::str_param(&params, "description")
                .trim()
                .chars()
                .take(MAX_DESCRIPTION)
                .collect();
            let description = if raw_description.is_empty() {
                "AA 账单".to_string()
            } else {
                raw_description
            };
            let split_type = if util::str_param(&params, "splitType") == "custom" {
                "custom"
            } else {
                "equal"
            };
            let mut member_ids: Vec<String> = Vec::new();
            if session.starts_with("p2p:") {
                let peer_name = session.trim_start_matches("p2p:").trim().to_lowercase();
                let peer = store::user_by_username(&state.db, &peer_name)
                    .await?
                    .ok_or_else(|| "对方不存在".to_string())?;
                if peer.id == me.id {
                    return Err("不能和自己创建 AA 账单".to_string());
                }
            } else if session.starts_with("g:") {
                let (row, _) = resolve_group(&state, &me, &session).await?;
                member_ids = store::group_members(&state.db, &row.id)
                    .await?
                    .into_iter()
                    .map(|member| member.user_id)
                    .collect();
            } else {
                return Err("AA 账单只能在私聊或群聊中创建".to_string());
            }
            let mut requested: Vec<String> = Vec::new();
            if let Some(list) = params.get("participantIds").and_then(|value| value.as_array()) {
                for item in list {
                    let Some(id) = item.as_str() else { continue };
                    if id == me.id || requested.iter().any(|existing| existing == id) {
                        continue;
                    }
                    requested.push(id.to_string());
                }
            }
            let candidates: Vec<String> = if !requested.is_empty() {
                requested
            } else {
                member_ids
                    .iter()
                    .filter(|id| *id != &me.id)
                    .cloned()
                    .collect()
            };
            if candidates.is_empty() {
                return Err("AA 账单至少要有 1 位参与者".to_string());
            }
            if candidates.len() > MAX_MEMBERS {
                return Err(format!("参与者不能超过 {MAX_MEMBERS} 人"));
            }
            if session.starts_with("g:")
                && candidates.iter().any(|id| !member_ids.contains(id))
            {
                return Err("参与者必须是群成员".to_string());
            }
            let mut custom_splits: std::collections::HashMap<String, i64> =
                std::collections::HashMap::new();
            if split_type == "custom" {
                let raw_splits = params
                    .get("customSplits")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let mut sum = 0;
                for id in &candidates {
                    let share = amount_of(&raw_splits, id, "分摊金额")?;
                    if share <= 0 {
                        return Err("每位参与者的分摊金额必须大于 0".to_string());
                    }
                    custom_splits.insert(id.clone(), share);
                    sum += share;
                }
                if sum != total {
                    return Err("自定义分摊金额之和必须等于账单总额".to_string());
                }
            } else if total < candidates.len() as i64 {
                return Err("账单总额不足以按人数均分".to_string());
            }
            let id = util::uuid();
            let created_at = util::now_ms();
            store::bill_create(
                &state.db,
                &id,
                &session,
                &me.id,
                &description,
                total,
                &candidates,
                split_type,
                &custom_splits,
                created_at + 7 * DAY_MS,
            )
            .await?;
            let bill = store::bill_get(&state.db, &id)
                .await?
                .ok_or_else(|| "账单创建失败".to_string())?;
            let detail = json!({
                "id": bill.id,
                "sessionId": bill.session_id,
                "creatorId": bill.creator_id,
                "description": bill.description,
                "totalAmount": bill.total_amount,
                "settledAmount": bill.settled_amount,
                "participantIds": bill.participant_ids,
                "splitType": bill.split_type,
                "status": bill.status,
                "createdAt": util::iso_from_ms(bill.created_at),
                "deadline": util::iso_from_ms(bill.deadline),
            });
            let sent = send_money(
                &state,
                &me,
                &session,
                description.clone(),
                "aabill",
                detail,
            )
            .await?;
            Ok(json!({
                "bill": {
                    "id": bill.id,
                    "sessionId": bill.session_id,
                    "creatorId": bill.creator_id,
                    "description": bill.description,
                    "totalAmount": bill.total_amount,
                    "settledAmount": bill.settled_amount,
                    "participantIds": bill.participant_ids,
                    "splitType": bill.split_type,
                    "status": bill.status,
                    "createdAt": util::iso_from_ms(bill.created_at),
                    "deadline": util::iso_from_ms(bill.deadline),
                },
                "detail": bill_json(&state, &bill, &me).await,
                "message": sent,
            }))
        }),
    );

    registry.add(
        "aa.candidates",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let session = util::str_param(&params, "sessionId").trim().to_string();
            if session.starts_with("g:") {
                let (row, _) = resolve_group(&state, &me, &session).await?;
                let members = store::group_members(&state.db, &row.id).await?;
                let mut candidates: Vec<Value> = Vec::new();
                for member in members {
                    if member.user_id == me.id {
                        continue;
                    }
                    candidates.push(json!({
                        "userId": member.user_id,
                        "username": username_of(&state, &member.user_id).await,
                    }));
                }
                return Ok(json!({ "candidates": candidates, "session": format!("g:{}", row.id) }));
            }
            if session.starts_with("p2p:") {
                let peer_name = session.trim_start_matches("p2p:").trim().to_lowercase();
                let peer = store::user_by_username(&state.db, &peer_name)
                    .await?
                    .ok_or_else(|| "对方不存在".to_string())?;
                return Ok(json!({
                    "candidates": [{ "userId": peer.id, "username": peer.username }],
                }));
            }
            Err("AA 账单只能在私聊或群聊中创建".to_string())
        }),
    );

    registry.add(
        "aa.detail",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let bill_id = util::str_param(&params, "billId").trim().to_string();
            if bill_id.is_empty() {
                return Err("缺少账单 ID".to_string());
            }
            let bill = store::bill_get(&state.db, &bill_id)
                .await?
                .ok_or_else(|| "账单不存在或已被删除".to_string())?;
            if !can_see_bill(&state, &me, &bill).await {
                return Err("你无权查看该账单".to_string());
            }
            Ok(bill_json(&state, &bill, &me).await)
        }),
    );

    registry.add(
        "aa.list",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let session = util::str_param(&params, "sessionId").trim().to_string();
            if session.is_empty() {
                let rows = store::bill_list_for_user(&state.db, &me.id).await?;
                return Ok(json!(rows
                    .iter()
                    .map(|bill| json!({
                        "id": bill.id,
                        "sessionId": bill.session_id,
                        "creatorId": bill.creator_id,
                        "description": bill.description,
                        "totalAmount": bill.total_amount,
                        "settledAmount": bill.settled_amount,
                        "participantIds": bill.participant_ids,
                        "splitType": bill.split_type,
                        "status": bill.status,
                        "createdAt": util::iso_from_ms(bill.created_at),
                        "deadline": util::iso_from_ms(bill.deadline),
                    }))
                    .collect::<Vec<Value>>()));
            }
            let rows = store::bill_list_session(&state.db, &session).await?;
            let mut visible: Vec<Value> = Vec::new();
            for bill in rows {
                if !can_see_bill(&state, &me, &bill).await {
                    continue;
                }
                visible.push(json!({
                    "id": bill.id,
                    "sessionId": bill.session_id,
                    "creatorId": bill.creator_id,
                    "description": bill.description,
                    "totalAmount": bill.total_amount,
                    "settledAmount": bill.settled_amount,
                    "participantIds": bill.participant_ids,
                    "splitType": bill.split_type,
                    "status": bill.status,
                    "createdAt": util::iso_from_ms(bill.created_at),
                    "deadline": util::iso_from_ms(bill.deadline),
                }));
            }
            Ok(json!(visible))
        }),
    );

    registry.add(
        "aa.pay",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let bill_id = util::str_param(&params, "billId").trim().to_string();
            if bill_id.is_empty() {
                return Err("缺少账单 ID".to_string());
            }
            let bill = store::bill_get(&state.db, &bill_id)
                .await?
                .ok_or_else(|| "账单不存在或已被删除".to_string())?;
            if !can_see_bill(&state, &me, &bill).await {
                return Err("你无权操作该账单".to_string());
            }
            let share = store::bill_share(&bill, &me.id)
                .ok_or_else(|| "你不是该账单的参与者".to_string())?;
            let amount = if params.get("amount").is_none() {
                share
            } else {
                amount_of(&params, "amount", "付款金额")?
            };
            let paid = store::bill_pay(&state.db, &bill_id, &me.id, amount).await?;
            let fresh = match paid {
                store::BillPayResult::Ok(row) => row,
                store::BillPayResult::Duplicate => return Err("你已经付过了".to_string()),
                store::BillPayResult::Insufficient => {
                    return Err("余额不足，无法支付这笔 AA 账单".to_string())
                }
                store::BillPayResult::Amount => {
                    return Err("付款金额与你的分摊金额不一致".to_string())
                }
                store::BillPayResult::Closed => {
                    return Err("该账单已结束，无法付款".to_string())
                }
                store::BillPayResult::Missing => return Err("账单不存在".to_string()),
            };
            announce_bill(&state, &fresh, &me).await;
            let balance = store::wallet_balance(&state.db, &me.id).await?;
            Ok(json!({
                "detail": bill_json(&state, &fresh, &me).await,
                "myBalance": balance,
            }))
        }),
    );

    registry.add(
        "aa.cancel",
        handler(|state, conn, params| async move {
            let me = require_user(&conn)?;
            let bill_id = util::str_param(&params, "billId").trim().to_string();
            if bill_id.is_empty() {
                return Err("缺少账单 ID".to_string());
            }
            let bill = store::bill_get(&state.db, &bill_id)
                .await?
                .ok_or_else(|| "账单不存在或已被删除".to_string())?;
            if bill.creator_id != me.id {
                return Err("只有发起人可以取消账单".to_string());
            }
            if !store::bill_cancel(&state.db, &bill_id).await? {
                return Err("该账单已结束，无法取消".to_string());
            }
            let fresh = store::bill_get(&state.db, &bill_id)
                .await?
                .ok_or_else(|| "账单不存在".to_string())?;
            announce_bill(&state, &fresh, &me).await;
            Ok(json!({ "detail": bill_json(&state, &fresh, &me).await }))
        }),
    );

    registry.add(
        "aa.overdue",
        handler(|state, conn, _params| async move {
            require_user(&conn)?;
            let bills = store::bill_overdue(&state.db).await?;
            for bill in &bills {
                state
                    .hub
                    .broadcast(
                        "aabill:update",
                        json!({ "id": bill.id, "status": "overdue" }),
                    )
                    .await;
            }
            Ok(json!(bills.len()))
        }),
    );
}
