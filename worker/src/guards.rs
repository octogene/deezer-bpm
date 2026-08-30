//! Edge rate limiters and the daily safety budget durable object.

use serde::{Deserialize, Serialize};
use worker::wasm_bindgen::JsValue;
use worker::*;

use crate::config::{Limits, MILLIS_PER_DAY};
use crate::http::client_ip;

const BUDGET_OBJECT_NAME: &str = "account";
const BUDGET_BINDING: &str = "SAFETY_BUDGET";

const IP_LIMITER: &str = "IP_RATE_LIMITER";
pub(crate) const CODE_LIMITER: &str = "CODE_RATE_LIMITER";
pub(crate) const CREATE_LIMITER: &str = "CREATE_RATE_LIMITER";
const GLOBAL_LIMITER: &str = "GLOBAL_RATE_LIMITER";

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct Admission {
    pub(crate) kind: AdmissionKind,
    pub(crate) read_rows: u64,
    pub(crate) write_rows: u64,
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub(crate) enum AdmissionKind {
    Sync,
    Create,
    /// Records D1 rows that were actually read after the fact. Settlements never
    /// count a request and are never rejected: the work already happened, so
    /// refusing one would lose the accounting without undoing the cost.
    Settlement,
}

#[derive(Debug, Serialize, Deserialize, Default)]
struct BudgetState {
    day: u64,
    requests: u64,
    creations: u64,
    read_rows: u64,
    write_rows: u64,
}

#[durable_object(fetch)]
pub struct SafetyBudget {
    state: State,
    env: Env,
}

impl DurableObject for SafetyBudget {
    fn new(state: State, env: Env) -> Self {
        Self { state, env }
    }

    async fn fetch(&self, mut req: Request) -> Result<Response> {
        let admission: Admission = req.json().await?;
        let limits = Limits::from_env(&self.env)?;
        let day = Date::now().as_millis() / MILLIS_PER_DAY;
        let storage = self.state.storage();
        let mut budget = storage
            .get::<BudgetState>("budget")
            .await?
            .unwrap_or_default();

        if budget.day != day {
            budget = BudgetState {
                day,
                ..BudgetState::default()
            };
        }

        let settlement = admission.kind == AdmissionKind::Settlement;
        let requests = budget.requests.saturating_add(u64::from(!settlement));
        let creations = budget
            .creations
            .saturating_add(u64::from(admission.kind == AdmissionKind::Create));
        let read_rows = budget.read_rows.saturating_add(admission.read_rows);
        let write_rows = budget.write_rows.saturating_add(admission.write_rows);

        if !settlement
            && (requests > limits.daily_requests
                || creations > limits.daily_creations
                || read_rows > limits.daily_read_rows
                || write_rows > limits.daily_write_rows)
        {
            return Response::error("daily safety budget exhausted", 503);
        }

        budget.requests = requests;
        budget.creations = creations;
        budget.read_rows = read_rows;
        budget.write_rows = write_rows;
        storage.put("budget", budget).await?;

        Response::ok("admitted")
    }
}

pub(crate) async fn apply_common_limits(req: &Request, env: &Env) -> Result<bool> {
    if !apply_limit(env, GLOBAL_LIMITER, "all").await? {
        return Ok(false);
    }
    apply_limit(env, IP_LIMITER, &client_ip(req)?).await
}

pub(crate) async fn apply_limit(env: &Env, binding: &str, key: &str) -> Result<bool> {
    let result = env.rate_limiter(binding)?.limit(key.to_string()).await?;
    Ok(result.success)
}

pub(crate) async fn admit(env: &Env, admission: Admission) -> Result<bool> {
    let namespace = env.durable_object(BUDGET_BINDING)?;
    let stub = namespace.get_by_name(BUDGET_OBJECT_NAME)?;
    let mut init = RequestInit::new();
    init.with_method(Method::Post);
    init.with_body(Some(JsValue::from_str(&serde_json::to_string(&admission)?)));
    init.headers.set("Content-Type", "application/json")?;
    let request = Request::new_with_init("https://budget/admit", &init)?;
    let response = stub.fetch_with_request(request).await?;

    if response.status_code() == 503 {
        return Ok(false);
    }
    if response.status_code() >= 400 {
        return Err(Error::RustError("safety budget request failed".into()));
    }

    Ok(true)
}
