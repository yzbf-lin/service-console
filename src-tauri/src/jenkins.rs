use std::{
    collections::{BTreeMap, BTreeSet, HashMap},
    fs,
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

use futures_util::StreamExt;
use percent_encoding::{NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use reqwest::header::{HeaderName, HeaderValue};
use reqwest::{Client, Method, Response, StatusCode};
use scraper::{ElementRef, Html, Selector};
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{Value, json};
use tokio::sync::RwLock;
use url::Url;
use uuid::Uuid;

use crate::{
    error::{AppError, AppResult},
    models::expand_home,
    runtime_log,
};

const KEYRING_SERVICE: &str = "service-console.jenkins";
const MAX_LOG_BYTES: usize = 2 * 1024 * 1024;
const MAX_BUILD_FORM_BYTES: usize = 1024 * 1024;
const MAX_BUILD_FORM_OPTIONS: usize = 5_000;
const MAX_PARAMETER_VALUE_LENGTH: usize = 16_384;
const MAX_MULTI_SELECT_VALUES: usize = 5_000;

#[derive(Debug, Clone, Default)]
struct BuildFormParameter {
    choices: Option<Vec<String>>,
    selected: Vec<String>,
    multiple: bool,
    hidden_value: Option<String>,
    has_hidden_value: bool,
    has_select: bool,
    fill_url: Option<String>,
}

#[derive(Debug, Clone)]
struct ActiveChoiceBinding {
    references: Vec<String>,
    endpoint: String,
    crumb: String,
    reference_only: bool,
}

#[derive(Debug, Default)]
struct BuildFormSnapshot {
    parameters: BTreeMap<String, BuildFormParameter>,
    active_choices: BTreeMap<String, ActiveChoiceBinding>,
    referer: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct JenkinsInstance {
    pub id: String,
    pub name: String,
    pub base_url: String,
    pub username: String,
    #[serde(default, deserialize_with = "deserialize_nullable_string")]
    pub ca_bundle: String,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub request_timeout: f64,
}

fn default_true() -> bool {
    true
}
fn default_timeout() -> f64 {
    15.0
}

fn deserialize_nullable_string<'de, D>(deserializer: D) -> Result<String, D::Error>
where
    D: Deserializer<'de>,
{
    Ok(Option::<String>::deserialize(deserializer)?.unwrap_or_default())
}

impl JenkinsInstance {
    fn normalize(mut self) -> AppResult<Self> {
        self.name = self.name.trim().to_owned();
        self.username = self.username.trim().to_owned();
        self.base_url = normalize_base_url(&self.base_url)?;
        self.ca_bundle = self.ca_bundle.trim().to_owned();
        if self.name.is_empty() || self.name.len() > 100 {
            return Err(AppError::bad_request(
                "Jenkins instance name must be between 1 and 100 characters",
            ));
        }
        if self.username.is_empty() || self.username.len() > 256 {
            return Err(AppError::bad_request(
                "Jenkins username must be between 1 and 256 characters",
            ));
        }
        if self.ca_bundle.len() > 4_096 {
            return Err(AppError::bad_request(
                "Jenkins CA bundle path must not exceed 4096 characters",
            ));
        }
        if !(1.0..=120.0).contains(&self.request_timeout) || !self.request_timeout.is_finite() {
            return Err(AppError::bad_request(
                "Jenkins request timeout must be between 1 and 120 seconds",
            ));
        }
        Ok(self)
    }
}

#[derive(Debug, Deserialize)]
struct InstanceFile {
    #[serde(default)]
    instances: Vec<JenkinsInstance>,
}

#[derive(Debug, Serialize)]
struct InstanceFileRef<'a> {
    version: u32,
    instances: Vec<&'a JenkinsInstance>,
}

pub struct JenkinsService {
    path: PathBuf,
    instances: RwLock<BTreeMap<String, JenkinsInstance>>,
    session_tokens: RwLock<HashMap<String, String>>,
}

impl JenkinsService {
    pub fn new(data_dir: impl AsRef<Path>) -> AppResult<Arc<Self>> {
        let data_dir = expand_home(data_dir);
        fs::create_dir_all(&data_dir)?;
        let path = data_dir.join("jenkins-instances.json");
        let instances = if path.exists() {
            let raw: Value = serde_json::from_slice(&fs::read(&path)?)?;
            let values = if raw.is_array() {
                serde_json::from_value(raw)?
            } else {
                serde_json::from_value::<InstanceFile>(raw)?.instances
            };
            let mut result = BTreeMap::new();
            for value in values {
                let value = JenkinsInstance::normalize(value)?;
                result.insert(value.id.clone(), value);
            }
            result
        } else {
            BTreeMap::new()
        };
        Ok(Arc::new(Self {
            path,
            instances: RwLock::new(instances),
            session_tokens: RwLock::new(HashMap::new()),
        }))
    }

    pub async fn list_instances(&self) -> Vec<Value> {
        let instances = self.instances.read().await;
        let mut result = Vec::new();
        for instance in instances.values() {
            result.push(self.public_instance(instance).await);
        }
        result
    }

    pub async fn create_instance(&self, input: JenkinsInstanceInput) -> AppResult<Value> {
        let token = required_token(input.token.as_deref())?;
        let instance = JenkinsInstance {
            id: Uuid::new_v4().to_string(),
            name: input.name,
            base_url: input.base_url,
            username: input.username,
            ca_bundle: input.ca_bundle.unwrap_or_default(),
            enabled: input.enabled,
            request_timeout: input.request_timeout,
        }
        .normalize()?;
        let mut instances = self.instances.write().await;
        ensure_unique_name(&instances, &instance.name, None)?;
        self.set_token(&instance.id, token).await?;
        instances.insert(instance.id.clone(), instance.clone());
        if let Err(error) = self.save_locked(&instances) {
            instances.remove(&instance.id);
            let _ = self.delete_token(&instance.id).await;
            return Err(error);
        }
        drop(instances);
        Ok(self.public_instance(&instance).await)
    }

    pub async fn update_instance(&self, id: &str, input: JenkinsInstanceInput) -> AppResult<Value> {
        let mut instances = self.instances.write().await;
        let current = instances
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::not_found(id.to_owned()))?;
        let updated = JenkinsInstance {
            id: id.into(),
            name: input.name,
            base_url: input.base_url,
            username: input.username,
            ca_bundle: input.ca_bundle.unwrap_or_default(),
            enabled: input.enabled,
            request_timeout: input.request_timeout,
        }
        .normalize()?;
        ensure_unique_name(&instances, &updated.name, Some(id))?;
        let previous_token = self.get_token(id).await?;
        let replacement_token = input
            .token
            .as_deref()
            .map(|token| required_token(Some(token)).map(str::to_owned))
            .transpose()?;
        if let Some(token) = replacement_token.as_deref() {
            self.set_token(id, token).await?;
        }
        instances.insert(id.into(), updated.clone());
        if let Err(error) = self.save_locked(&instances) {
            instances.insert(id.into(), current);
            if replacement_token.is_some() {
                match previous_token.as_deref() {
                    Some(token) => self.set_token(id, token).await?,
                    None => self.delete_token(id).await?,
                }
            }
            return Err(error);
        }
        drop(instances);
        Ok(self.public_instance(&updated).await)
    }

    pub async fn delete_instance(&self, id: &str) -> AppResult<()> {
        let mut instances = self.instances.write().await;
        let removed = instances
            .remove(id)
            .ok_or_else(|| AppError::not_found(id.to_owned()))?;
        if let Err(error) = self.save_locked(&instances) {
            instances.insert(id.into(), removed);
            return Err(error);
        }
        if let Err(error) = self.delete_token(id).await {
            instances.insert(id.into(), removed);
            self.save_locked(&instances)?;
            return Err(error);
        }
        Ok(())
    }

    pub async fn test_connection(&self, id: &str) -> AppResult<Value> {
        let (instance, token) = self.connection(id).await?;
        let response = self
            .send(&instance, &token, Method::GET, "/api/json", None, false)
            .await?;
        let version = response
            .headers()
            .get("x-jenkins")
            .and_then(|value| value.to_str().ok())
            .map(str::to_owned);
        Ok(json!({"ok": true, "version": version, "url": instance.base_url}))
    }

    pub async fn list_jobs(
        &self,
        id: &str,
        folder: &str,
        query: Option<&str>,
    ) -> AppResult<Vec<Value>> {
        if folder.len() > 1_000 {
            return Err(AppError::bad_request(
                "Jenkins folder path must not exceed 1000 characters",
            ));
        }
        if query.is_some_and(|query| query.len() > 200) {
            return Err(AppError::bad_request(
                "Jenkins job query must not exceed 200 characters",
            ));
        }
        let (instance, token) = self.connection(id).await?;
        let folder = clean_job(folder);
        if !folder.is_empty() {
            validate_job_path(&folder)?;
        }
        let path = format!(
            "{}/api/json?tree=jobs[name,fullName,url,_class,color,buildable,inQueue,lastBuild[number,url,displayName,fullDisplayName,building,result,timestamp,duration,estimatedDuration,queueId,description]]",
            job_path(&folder)
        );
        let payload = response_json(
            self.send(&instance, &token, Method::GET, &path, None, false)
                .await?,
        )
        .await?;
        let query = query.unwrap_or_default().trim().to_lowercase();
        Ok(payload["jobs"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|job| {
                let normalized = normalize_job(job, &folder);
                let name = normalized["name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase();
                let full = normalized["full_name"]
                    .as_str()
                    .unwrap_or_default()
                    .to_lowercase();
                (query.is_empty() || name.contains(&query) || full.contains(&query))
                    .then_some(normalized)
            })
            .collect())
    }

    pub async fn get_job(
        &self,
        id: &str,
        job: &str,
        include_parameter_options: bool,
        parameter_values: Option<&BTreeMap<String, Value>>,
    ) -> AppResult<Value> {
        if let Some(values) = parameter_values {
            validate_parameter_payload(values)?;
        }
        let (instance, token) = self.connection(id).await?;
        let job = clean_required_job(job)?;
        self.get_job_with_connection(
            &instance,
            &token,
            &job,
            include_parameter_options,
            false,
            parameter_values,
        )
        .await
    }

    async fn get_job_with_connection(
        &self,
        instance: &JenkinsInstance,
        token: &str,
        job: &str,
        include_parameter_options: bool,
        include_hidden: bool,
        parameter_values: Option<&BTreeMap<String, Value>>,
    ) -> AppResult<Value> {
        let mut parameter_fields =
            "name,type,_class,description,choices,choiceType,sectionHeader".to_owned();
        if include_parameter_options {
            parameter_fields
                .push_str(",defaultParameterValue[value],allValueItems[values[name,value],errors]");
        }
        let tree = format!(
            "name,fullName,url,color,_class,buildable,inQueue,description,actions[_class,parameterDefinitions[{parameter_fields}]],property[_class,parameterDefinitions[{parameter_fields}]],lastBuild[number,url,displayName,fullDisplayName,building,result,timestamp,duration,estimatedDuration,queueId,description]"
        );
        let client = client_for(instance)?;
        let payload = response_json(
            self.send_with_client(
                &client,
                instance,
                token,
                Method::GET,
                &format!(
                    "{}/api/json?tree={}",
                    job_path(job),
                    utf8_percent_encode(&tree, NON_ALPHANUMERIC)
                ),
                None,
                false,
            )
            .await?,
        )
        .await?;
        let mut detail = normalize_job_detail(
            &payload,
            job,
            include_parameter_options,
            include_hidden || include_parameter_options,
        );
        if include_parameter_options {
            let empty_values = BTreeMap::new();
            self.resolve_build_form_parameters(
                &client,
                instance,
                token,
                job,
                &mut detail,
                parameter_values.unwrap_or(&empty_values),
            )
            .await?;
        }
        if !include_hidden {
            make_job_detail_public(&mut detail);
        }
        Ok(detail)
    }

    pub async fn list_builds(&self, id: &str, job: &str, limit: usize) -> AppResult<Vec<Value>> {
        let (instance, token) = self.connection(id).await?;
        let job = clean_required_job(job)?;
        let path = format!(
            "{}/api/json?tree=builds[number,url,displayName,fullDisplayName,building,result,timestamp,duration,estimatedDuration,queueId,description]{{0,{limit}}}",
            job_path(&job)
        );
        let payload = response_json(
            self.send(&instance, &token, Method::GET, &path, None, false)
                .await?,
        )
        .await?;
        Ok(payload["builds"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(normalize_build)
            .filter(|build| build["number"].as_u64().is_some_and(|number| number > 0))
            .take(limit)
            .collect())
    }

    pub async fn get_build(&self, id: &str, job: &str, number: u64) -> AppResult<Value> {
        let (instance, token) = self.connection(id).await?;
        let job = clean_required_job(job)?;
        let payload = response_json(
            self.send(
                &instance,
                &token,
                Method::GET,
                &format!("{}/{number}/api/json", job_path(&job)),
                None,
                false,
            )
            .await?,
        )
        .await?;
        normalize_build(&payload)
            .filter(|build| build["number"].as_u64().is_some_and(|number| number > 0))
            .ok_or_else(|| AppError::Internal("Jenkins returned an invalid build".into()))
    }

    pub async fn trigger_build(
        &self,
        id: &str,
        job: &str,
        parameters: &BTreeMap<String, Value>,
    ) -> AppResult<Value> {
        validate_parameter_payload(parameters)?;
        let (instance, token) = self.connection(id).await?;
        let job = clean_required_job(job)?;
        let detail = self
            .get_job_with_connection(&instance, &token, &job, true, true, Some(parameters))
            .await?;
        let definitions = detail["parameters"].as_array().cloned().unwrap_or_default();
        let parameterized = detail["parameterized"].as_bool().unwrap_or(false);
        let hidden_values = detail["_hidden_values"]
            .as_object()
            .cloned()
            .unwrap_or_default();
        let (submitted, classic) =
            validate_build_parameters(parameters, &definitions, parameterized, &hidden_values)?;
        let endpoint = if classic {
            "build"
        } else if parameterized {
            "buildWithParameters"
        } else {
            "build"
        };
        let form: Vec<(String, String)> = if classic {
            vec![(
                "json".into(),
                serde_json::to_string(&json!({
                    "parameter": submitted
                        .iter()
                        .map(|(name, value)| json!({"name": name, "value": value}))
                        .collect::<Vec<_>>()
                }))
                .map_err(|error| AppError::Internal(error.to_string()))?,
            )]
        } else {
            submitted
                .iter()
                .flat_map(|(name, value)| parameter_values(name, value))
                .collect()
        };
        let response = self
            .send(
                &instance,
                &token,
                Method::POST,
                &format!("{}/{endpoint}", job_path(&job)),
                Some(&form),
                true,
            )
            .await?;
        let location = response
            .headers()
            .get("location")
            .and_then(|value| value.to_str().ok())
            .unwrap_or_default()
            .to_owned();
        let queue_id = location
            .trim_end_matches('/')
            .rsplit('/')
            .next()
            .and_then(|value| value.parse::<u64>().ok());
        Ok(json!({"id": queue_id, "url": location, "location": location}))
    }

    pub async fn stop_build(&self, id: &str, job: &str, number: u64) -> AppResult<()> {
        let (instance, token) = self.connection(id).await?;
        let job = clean_required_job(job)?;
        self.send(
            &instance,
            &token,
            Method::POST,
            &format!("{}/{number}/stop", job_path(&job)),
            Some(&[]),
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn list_queue(&self, id: &str) -> AppResult<Vec<Value>> {
        let (instance, token) = self.connection(id).await?;
        let payload = response_json(
            self.send(
                &instance,
                &token,
                Method::GET,
                "/queue/api/json",
                None,
                false,
            )
            .await?,
        )
        .await?;
        Ok(payload["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(normalize_queue)
            .filter(|item| item["id"].as_u64().is_some_and(|id| id > 0))
            .collect())
    }

    pub async fn cancel_queue(&self, id: &str, queue_id: u64) -> AppResult<()> {
        let (instance, token) = self.connection(id).await?;
        self.send(
            &instance,
            &token,
            Method::POST,
            &format!("/queue/cancelItem?id={queue_id}"),
            Some(&[]),
            true,
        )
        .await?;
        Ok(())
    }

    pub async fn progressive_log(
        &self,
        id: &str,
        job: &str,
        number: u64,
        start: usize,
    ) -> AppResult<Value> {
        let (instance, token) = self.connection(id).await?;
        let job = clean_required_job(job)?;
        let response = self
            .send(
                &instance,
                &token,
                Method::GET,
                &format!(
                    "{}/{number}/logText/progressiveText?start={start}",
                    job_path(&job)
                ),
                None,
                false,
            )
            .await?;
        let headers = response.headers().clone();
        let bytes = response
            .bytes()
            .await
            .map_err(|error| AppError::Internal(error.to_string()))?;
        if bytes.len() > MAX_LOG_BYTES {
            return Err(AppError::conflict(
                "Jenkins log chunk exceeded the 2 MiB limit",
            ));
        }
        let text = String::from_utf8_lossy(&bytes).into_owned();
        let next = headers
            .get("x-text-size")
            .and_then(|value| value.to_str().ok())
            .and_then(|value| value.parse().ok())
            .unwrap_or(start + bytes.len());
        let more = headers
            .get("x-more-data")
            .and_then(|value| value.to_str().ok())
            .is_some_and(|value| value.eq_ignore_ascii_case("true"));
        Ok(
            json!({"offset": start, "next_offset": next, "text": text, "more": more, "complete": !more}),
        )
    }

    async fn resolve_build_form_parameters(
        &self,
        client: &Client,
        instance: &JenkinsInstance,
        token: &str,
        job: &str,
        detail: &mut Value,
        submitted: &BTreeMap<String, Value>,
    ) -> AppResult<()> {
        let expected_names: BTreeSet<String> = detail["parameters"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|parameter| {
                parameter["type"] == "hidden"
                    || parameter["_form_dynamic"] == true
                    || (parameter["_form_options"] == true && parameter["options_state"] != "ready")
            })
            .filter_map(|parameter| parameter["name"].as_str().map(str::to_owned))
            .collect();
        if expected_names.is_empty() {
            return Ok(());
        }

        let mut snapshot = self
            .get_build_form_snapshot(client, instance, token, job, &expected_names)
            .await;
        self.resolve_form_fill_choices(client, instance, token, job, &mut snapshot)
            .await;
        let hidden_values = merge_build_form_parameters(
            detail["parameters"]
                .as_array_mut()
                .expect("normalized parameters must be an array"),
            &snapshot.parameters,
        );
        apply_active_choice_bindings(
            detail["parameters"]
                .as_array_mut()
                .expect("normalized parameters must be an array"),
            &snapshot.active_choices,
        );
        self.resolve_active_choice_parameters(
            client,
            instance,
            token,
            &snapshot,
            detail["parameters"]
                .as_array_mut()
                .expect("normalized parameters must be an array"),
            submitted,
        )
        .await;
        detail["_hidden_values"] = json!(hidden_values);
        Ok(())
    }

    async fn get_build_form_snapshot(
        &self,
        client: &Client,
        instance: &JenkinsInstance,
        token: &str,
        job: &str,
        expected_names: &BTreeSet<String>,
    ) -> BuildFormSnapshot {
        let referer = format!("{}{}/build", instance.base_url, job_path(job));
        let response = match client
            .get(&referer)
            .query(&[("delay", "0sec")])
            .basic_auth(&instance.username, Some(token))
            .header("Accept", "text/html,application/xhtml+xml")
            .header(
                "Referer",
                format!("{}{}/", instance.base_url, job_path(job)),
            )
            .header(
                "User-Agent",
                "Mozilla/5.0 (compatible; Service-Console/Jenkins)",
            )
            .timeout(Duration::from_secs_f64(
                instance.request_timeout.clamp(30.0, 60.0),
            ))
            .send()
            .await
        {
            Ok(response) if matches!(response.status().as_u16(), 200 | 405) => response,
            _ => return BuildFormSnapshot::default(),
        };
        let bytes = match bounded_response_bytes(response, MAX_BUILD_FORM_BYTES).await {
            Ok(bytes) => bytes,
            Err(()) => return BuildFormSnapshot::default(),
        };
        parse_build_form(&String::from_utf8_lossy(&bytes), expected_names, referer)
    }

    async fn resolve_form_fill_choices(
        &self,
        client: &Client,
        instance: &JenkinsInstance,
        token: &str,
        job: &str,
        snapshot: &mut BuildFormSnapshot,
    ) {
        let descriptor_prefix = format!("{}/descriptorByName/", job_path(job));
        let candidates: Vec<(String, String)> = snapshot
            .parameters
            .iter()
            .filter_map(|(name, parameter)| {
                parameter
                    .fill_url
                    .as_ref()
                    .map(|url| (name.clone(), url.clone()))
            })
            .collect();
        for (name, fill_url) in candidates {
            if fill_url.starts_with("//") || Url::parse(&fill_url).is_ok() || fill_url.contains('#')
            {
                continue;
            }
            let Ok(base) = Url::parse(&format!("{}/", instance.base_url)) else {
                continue;
            };
            let Ok(url) = base.join(&fill_url) else {
                continue;
            };
            if url.origin() != base.origin() {
                continue;
            }
            let endpoint = jenkins_relative_endpoint(instance, url.path());
            if !endpoint.starts_with(&descriptor_prefix) || !endpoint.ends_with("/fillValueItems") {
                continue;
            }
            let query: Vec<(String, String)> = url
                .query_pairs()
                .map(|(key, value)| (key.into_owned(), value.into_owned()))
                .collect();
            if query.len() > 20
                || !query
                    .iter()
                    .any(|(key, value)| key == "param" && value == &name)
            {
                continue;
            }
            let response = match client
                .get(format!("{}{}", instance.base_url, endpoint))
                .query(&query)
                .basic_auth(&instance.username, Some(token))
                .send()
                .await
            {
                Ok(response) if response.status().is_success() => response,
                _ => continue,
            };
            let Ok(bytes) = bounded_response_bytes(response, MAX_BUILD_FORM_BYTES).await else {
                continue;
            };
            let Ok(payload) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let choices = fill_value_item_choices(&payload);
            if choices.is_empty() {
                continue;
            }
            if let Some(parameter) = snapshot.parameters.get_mut(&name) {
                parameter.choices = Some(choices);
            }
        }
    }

    async fn resolve_active_choice_parameters(
        &self,
        client: &Client,
        instance: &JenkinsInstance,
        token: &str,
        snapshot: &BuildFormSnapshot,
        parameters: &mut [Value],
        submitted: &BTreeMap<String, Value>,
    ) {
        let mut values =
            active_choice_reference_values(parameters, &snapshot.parameters, submitted);
        for parameter in parameters {
            let name = parameter["name"].as_str().unwrap_or_default().to_owned();
            let Some(binding) = snapshot.active_choices.get(&name) else {
                continue;
            };
            let reference_text = binding
                .references
                .iter()
                .map(|reference| {
                    format!(
                        "{reference}={}",
                        active_choice_reference_value(values.get(reference))
                    )
                })
                .collect::<Vec<_>>()
                .join("__LESEP__");
            let Some((choices, selected)) = self
                .request_active_choice_values(
                    client,
                    instance,
                    token,
                    binding,
                    &snapshot.referer,
                    &reference_text,
                )
                .await
            else {
                continue;
            };
            parameter["choices"] = if choices.is_empty() {
                Value::Null
            } else {
                json!(choices)
            };
            parameter["options_state"] = json!(if choices.is_empty() {
                "unavailable"
            } else {
                "ready"
            });
            if let Some(first) = selected.first() {
                parameter["default"] = if parameter["multiple"] == true {
                    json!(selected)
                } else {
                    json!(first)
                };
            }
            if let Some(value) = submitted.get(&name) {
                values.insert(name, value.clone());
            } else if parameter["multiple"] == true && !selected.is_empty() {
                values.insert(name, json!(selected));
            } else if let Some(first) = selected.first().or_else(|| choices.first()) {
                values.insert(name, json!(first));
            }
        }
    }

    async fn request_active_choice_values(
        &self,
        client: &Client,
        instance: &JenkinsInstance,
        token: &str,
        binding: &ActiveChoiceBinding,
        referer: &str,
        reference_text: &str,
    ) -> Option<(Vec<String>, Vec<String>)> {
        let endpoint = jenkins_relative_endpoint(instance, &binding.endpoint)
            .trim_end_matches('/')
            .to_owned();
        let endpoint_pattern = Regex::new(r"^/\$stapler/bound/[0-9A-Za-z-]{1,128}$").ok()?;
        if !endpoint_pattern.is_match(&endpoint) {
            return None;
        }
        let send = |suffix: &str, body: String| {
            client
                .post(format!("{}{}{suffix}", instance.base_url, endpoint))
                .basic_auth(&instance.username, Some(token))
                .header("Accept", "application/json")
                .header(
                    "Content-Type",
                    "application/x-stapler-method-invocation;charset=UTF-8",
                )
                .header("Crumb", &binding.crumb)
                .header("Referer", referer)
                .header(
                    "User-Agent",
                    "Mozilla/5.0 (compatible; Service-Console/Jenkins)",
                )
                .timeout(Duration::from_secs_f64(
                    instance.request_timeout.clamp(30.0, 60.0),
                ))
                .body(body)
        };
        let update = send("/doUpdate", serde_json::to_string(&[reference_text]).ok()?)
            .send()
            .await
            .ok()?;
        if !matches!(update.status().as_u16(), 200 | 204) {
            return None;
        }
        let response = send("/getChoicesForUI", "[]".into()).send().await.ok()?;
        if response.status() != StatusCode::OK {
            return None;
        }
        let bytes = bounded_response_bytes(response, MAX_BUILD_FORM_BYTES)
            .await
            .ok()?;
        normalize_active_choice_response(
            &serde_json::from_slice(&bytes).ok()?,
            binding.reference_only,
        )
    }

    async fn connection(&self, id: &str) -> AppResult<(JenkinsInstance, String)> {
        let instance = self
            .instances
            .read()
            .await
            .get(id)
            .cloned()
            .ok_or_else(|| AppError::not_found(id.to_owned()))?;
        if !instance.enabled {
            return Err(AppError::conflict(format!(
                "Jenkins instance is disabled: {}",
                instance.name
            )));
        }
        let token = self.get_token(id).await?.ok_or_else(|| {
            AppError::conflict(format!(
                "Jenkins API token is missing for {}",
                instance.name
            ))
        })?;
        Ok((instance, token))
    }

    async fn send(
        &self,
        instance: &JenkinsInstance,
        token: &str,
        method: Method,
        path: &str,
        form: Option<&[(String, String)]>,
        write: bool,
    ) -> AppResult<Response> {
        let client = client_for(instance)?;
        self.send_with_client(&client, instance, token, method, path, form, write)
            .await
    }

    #[allow(clippy::too_many_arguments)]
    async fn send_with_client(
        &self,
        client: &Client,
        instance: &JenkinsInstance,
        token: &str,
        method: Method,
        path: &str,
        form: Option<&[(String, String)]>,
        write: bool,
    ) -> AppResult<Response> {
        let mut request = client
            .request(method.clone(), format!("{}{}", instance.base_url, path))
            .basic_auth(&instance.username, Some(token));
        let crumb = if write {
            self.crumb(client, instance, token).await?
        } else {
            None
        };
        if let Some((name, value)) = crumb.as_ref() {
            request = request.header(name, value);
        }
        if let Some(form) = form {
            request = request.form(form);
        }
        let response = request
            .send()
            .await
            .map_err(|error| AppError::conflict(format!("Jenkins request failed: {error}")))?;
        if response.status().is_success() || response.status().is_redirection() {
            return Ok(response);
        }
        let status = response.status();
        let detail = response.text().await.unwrap_or_default();
        if write {
            let crumb_rejected = matches!(status, StatusCode::BAD_REQUEST | StatusCode::FORBIDDEN)
                && detail.to_lowercase().contains("crumb");
            let message = if status == StatusCode::UNAUTHORIZED {
                "Jenkins authentication failed"
            } else if crumb_rejected && crumb.is_some() {
                "Jenkins rejected the CSRF crumb"
            } else if crumb_rejected {
                "Jenkins requires a CSRF crumb, but no crumb was available"
            } else if status == StatusCode::FORBIDDEN {
                "Jenkins write permission denied"
            } else {
                "Jenkins rejected the write request"
            };
            return Err(AppError::conflict(message));
        }
        let safe_detail = bounded(&detail.replace(token, "[redacted]"), 400);
        Err(AppError::conflict(format!(
            "Jenkins returned HTTP {}: {safe_detail}",
            status.as_u16(),
        )))
    }

    async fn crumb(
        &self,
        client: &Client,
        instance: &JenkinsInstance,
        token: &str,
    ) -> AppResult<Option<(HeaderName, HeaderValue)>> {
        let response = client
            .get(format!("{}/crumbIssuer/api/json", instance.base_url))
            .basic_auth(&instance.username, Some(token))
            .send()
            .await
            .map_err(|error| AppError::conflict(error.to_string()))?;
        if matches!(
            response.status(),
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN | StatusCode::NOT_FOUND
        ) {
            return Ok(None);
        }
        if !response.status().is_success() {
            return Err(AppError::conflict(
                "Jenkins crumb issuer rejected the request",
            ));
        }
        let payload: Value = response
            .json()
            .await
            .map_err(|error| AppError::conflict(error.to_string()))?;
        let name = payload["crumbRequestField"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 256)
            .ok_or_else(|| AppError::conflict("Jenkins returned an invalid CSRF crumb response"))?;
        let value = payload["crumb"]
            .as_str()
            .filter(|value| !value.is_empty() && value.len() <= 4_096)
            .ok_or_else(|| AppError::conflict("Jenkins returned an invalid CSRF crumb response"))?;
        let header_name = HeaderName::from_bytes(name.as_bytes())
            .map_err(|_| AppError::conflict("Jenkins returned an invalid CSRF crumb response"))?;
        if matches!(
            header_name.as_str(),
            "authorization" | "cookie" | "host" | "content-length" | "content-type"
        ) {
            return Err(AppError::conflict(
                "Jenkins returned an invalid CSRF crumb response",
            ));
        }
        let header_value = HeaderValue::from_str(value)
            .map_err(|_| AppError::conflict("Jenkins returned an invalid CSRF crumb response"))?;
        Ok(Some((header_name, header_value)))
    }

    async fn public_instance(&self, instance: &JenkinsInstance) -> Value {
        let token = self.get_token(&instance.id).await;
        json!({
            "id": instance.id, "name": instance.name, "base_url": instance.base_url,
            "username": instance.username,
            "ca_bundle": instance.ca_bundle,
            "enabled": instance.enabled, "request_timeout": instance.request_timeout,
            "token_present": token.as_ref().ok().and_then(|value| value.as_ref()).is_some(),
            "credential_error": token.err().map(|error| error.to_string())
        })
    }

    fn save_locked(&self, instances: &BTreeMap<String, JenkinsInstance>) -> AppResult<()> {
        let mut encoded = serde_json::to_vec_pretty(&InstanceFileRef {
            version: 1,
            instances: instances.values().collect(),
        })?;
        encoded.push(b'\n');
        let temporary = self.path.with_extension(format!("tmp-{}", Uuid::new_v4()));
        fs::write(&temporary, encoded)?;
        fs::rename(temporary, &self.path)?;
        Ok(())
    }

    async fn get_token(&self, id: &str) -> AppResult<Option<String>> {
        if let Some(value) = self.session_tokens.read().await.get(id).cloned() {
            return Ok(Some(value));
        }
        match keyring::Entry::new(KEYRING_SERVICE, id).and_then(|entry| entry.get_password()) {
            Ok(value) => Ok(Some(value)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(error) => Err(AppError::Internal(format!(
                "Jenkins credential store failed: {error}"
            ))),
        }
    }

    async fn set_token(&self, id: &str, token: &str) -> AppResult<()> {
        match keyring::Entry::new(KEYRING_SERVICE, id).and_then(|entry| entry.set_password(token)) {
            Ok(()) => Ok(()),
            Err(error) => {
                self.session_tokens
                    .write()
                    .await
                    .insert(id.into(), token.into());
                runtime_log::warn(
                    "jenkins.credential_not_persisted",
                    format_args!("token is available for this session only: {error}"),
                );
                Ok(())
            }
        }
    }

    async fn delete_token(&self, id: &str) -> AppResult<()> {
        self.session_tokens.write().await.remove(id);
        match keyring::Entry::new(KEYRING_SERVICE, id).and_then(|entry| entry.delete_credential()) {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(error) => Err(AppError::Internal(format!(
                "Jenkins credential delete failed: {error}"
            ))),
        }
    }
}

#[derive(Debug, Deserialize)]
pub struct JenkinsInstanceInput {
    pub name: String,
    pub base_url: String,
    pub username: String,
    pub token: Option<String>,
    pub ca_bundle: Option<String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    #[serde(default = "default_timeout")]
    pub request_timeout: f64,
}

async fn bounded_response_bytes(response: Response, limit: usize) -> Result<Vec<u8>, ()> {
    if response
        .content_length()
        .is_some_and(|length| length > limit as u64)
    {
        return Err(());
    }
    let mut bytes = Vec::new();
    let mut stream = response.bytes_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| ())?;
        if bytes.len().saturating_add(chunk.len()) > limit {
            return Err(());
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok(bytes)
}

fn parse_build_form(
    html: &str,
    expected_names: &BTreeSet<String>,
    referer: String,
) -> BuildFormSnapshot {
    let document = Html::parse_document(html);
    let form_selector = Selector::parse("form").expect("valid selector");
    let parameter_selector = Selector::parse(r#"div[name="parameter"]"#).expect("valid selector");
    let input_selector = Selector::parse("input").expect("valid selector");
    let select_selector = Selector::parse("select").expect("valid selector");
    let option_selector = Selector::parse("option").expect("valid selector");
    let mut parameters: BTreeMap<String, BuildFormParameter> = BTreeMap::new();

    let Some(form) = document
        .select(&form_selector)
        .find(|form| is_parameter_form(form))
    else {
        return BuildFormSnapshot::default();
    };
    for container in form.select(&parameter_selector) {
        let name = container
            .select(&input_selector)
            .find(|input| attr_eq(input, "name", "name"))
            .and_then(|input| input.value().attr("value"))
            .filter(|name| expected_names.contains(*name))
            .map(str::to_owned);
        let Some(name) = name else { continue };
        let mut parsed = BuildFormParameter::default();

        if let Some(select) = container
            .select(&select_selector)
            .find(|select| attr_eq(select, "name", "value"))
        {
            parsed.has_select = true;
            parsed.multiple = select.value().attr("multiple").is_some();
            parsed.fill_url = select
                .value()
                .attr("fillurl")
                .filter(|value| value.len() <= 4_096)
                .map(str::to_owned);
            let mut choices = Vec::new();
            for option in select
                .select(&option_selector)
                .take(MAX_BUILD_FORM_OPTIONS + 1)
            {
                if choices.len() >= MAX_BUILD_FORM_OPTIONS {
                    choices.clear();
                    break;
                }
                if option.value().attr("disabled").is_some() {
                    continue;
                }
                let value = option
                    .value()
                    .attr("value")
                    .map(str::to_owned)
                    .unwrap_or_else(|| option.text().collect::<String>().trim().to_owned());
                if value.len() > MAX_PARAMETER_VALUE_LENGTH || choices.contains(&value) {
                    continue;
                }
                if option.value().attr("selected").is_some() {
                    parsed.selected.push(value.clone());
                }
                choices.push(value);
            }
            parsed.choices = Some(choices);
        } else {
            let mut control_choices = Vec::new();
            for input in container.select(&input_selector) {
                if !attr_eq(&input, "name", "value") {
                    continue;
                }
                let input_type = input
                    .value()
                    .attr("type")
                    .unwrap_or_default()
                    .to_ascii_lowercase();
                let value = input.value().attr("value").unwrap_or_default();
                if value.len() > MAX_PARAMETER_VALUE_LENGTH {
                    continue;
                }
                if input_type == "hidden" {
                    parsed.has_hidden_value = true;
                    parsed.hidden_value = Some(value.to_owned());
                } else if matches!(input_type.as_str(), "checkbox" | "radio") {
                    if !control_choices.iter().any(|candidate| candidate == value)
                        && control_choices.len() < MAX_BUILD_FORM_OPTIONS
                    {
                        control_choices.push(value.to_owned());
                    }
                    if input.value().attr("checked").is_some()
                        && !parsed.selected.iter().any(|candidate| candidate == value)
                    {
                        parsed.selected.push(value.to_owned());
                    }
                    parsed.multiple |= input_type == "checkbox";
                }
            }
            if !control_choices.is_empty() {
                parsed.has_select = true;
                parsed.choices = Some(control_choices);
            }
        }
        if parsed.has_select || parsed.has_hidden_value {
            match parameters.get(&name) {
                Some(existing) if existing.has_select || !parsed.has_select => {}
                _ => {
                    parameters.insert(name, parsed);
                }
            }
        }
    }

    let active_choices = parse_active_choice_bindings(&document, expected_names);
    BuildFormSnapshot {
        parameters,
        active_choices,
        referer,
    }
}

fn is_parameter_form(form: &ElementRef<'_>) -> bool {
    if !attr_eq(form, "method", "post") {
        return false;
    }
    if attr_eq(form, "name", "parameters") {
        return true;
    }
    let action = form.value().attr("action").unwrap_or_default();
    let path = action.split(['?', '#']).next().unwrap_or_default();
    let path = path.trim_end_matches('/').to_ascii_lowercase();
    path == "build" || path.ends_with("/build")
}

fn attr_eq(element: &ElementRef<'_>, name: &str, expected: &str) -> bool {
    element
        .value()
        .attr(name)
        .is_some_and(|value| value.eq_ignore_ascii_case(expected))
}

fn parse_active_choice_bindings(
    document: &Html,
    expected_names: &BTreeSet<String>,
) -> BTreeMap<String, ActiveChoiceBinding> {
    let script_selector = Selector::parse("script").expect("valid selector");
    let constructor = Regex::new(
        r#"(?s)new\s+UnoChoice\.(CascadeParameter|DynamicReferenceParameter)\(\s*(['"])(.*?)['"]"#,
    )
    .expect("valid regex");
    let proxy = Regex::new(
        r#"(?s)makeStaplerProxy\(\s*(['"])(.*?)['"]\s*,\s*(['"])(.*?)['"]\s*,\s*\[([^]]+)]"#,
    )
    .expect("valid regex");
    let reference_pattern =
        Regex::new(r#"(?s)referencedParameters\.push\(\s*(['"])(.*?)['"]\s*\)"#)
            .expect("valid regex");
    let endpoint_pattern =
        Regex::new(r"^/(?:[0-9A-Za-z._~-]+/)*\$stapler/bound/[0-9A-Za-z-]{1,128}$")
            .expect("valid regex");
    let mut result = BTreeMap::new();
    for script in document.select(&script_selector) {
        let source: String = script.text().collect();
        if source.len() > 256 * 1024 {
            continue;
        }
        let (Some(constructor), Some(proxy)) =
            (constructor.captures(&source), proxy.captures(&source))
        else {
            continue;
        };
        let name = decode_js_string(&constructor[3], &constructor[2]);
        let endpoint = decode_js_string(&proxy[2], &proxy[1]);
        let crumb = decode_js_string(&proxy[4], &proxy[3]);
        let methods = &proxy[5];
        if !expected_names.contains(&name)
            || !endpoint_pattern.is_match(&endpoint)
            || crumb.is_empty()
            || crumb.len() > 4_096
            || !crumb.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
            || !methods.contains("doUpdate")
            || !methods.contains("getChoicesForUI")
        {
            continue;
        }
        let mut references = Vec::new();
        for captures in reference_pattern.captures_iter(&source) {
            let reference = decode_js_string(&captures[2], &captures[1]);
            if expected_names.contains(&reference) && !references.contains(&reference) {
                references.push(reference);
            }
        }
        result.insert(
            name,
            ActiveChoiceBinding {
                references,
                endpoint,
                crumb,
                reference_only: &constructor[1] == "DynamicReferenceParameter",
            },
        );
    }
    result
}

fn decode_js_string(value: &str, quote: &str) -> String {
    if quote == "\"" {
        serde_json::from_str::<String>(&format!("\"{value}\"")).unwrap_or_default()
    } else {
        value.replace(r"\'", "'").replace(r"\\", r"\")
    }
}

fn merge_build_form_parameters(
    parameters: &mut [Value],
    form_parameters: &BTreeMap<String, BuildFormParameter>,
) -> BTreeMap<String, String> {
    let mut hidden_values = BTreeMap::new();
    for parameter in parameters {
        let name = parameter["name"].as_str().unwrap_or_default().to_owned();
        let form = form_parameters.get(&name);
        if parameter["type"] == "hidden" {
            if let Some(form) = form.filter(|form| form.has_hidden_value) {
                hidden_values.insert(name, form.hidden_value.clone().unwrap_or_default());
            }
            continue;
        }
        if parameter["_form_options"] != true || parameter["type"] == "reference" {
            continue;
        }
        let mut choices = form
            .and_then(|form| form.choices.clone())
            .unwrap_or_default();
        if parameter["_filesystem_list"] == true && choices.len() == 1 {
            let selected = form.map(|form| &form.selected);
            if !selected.is_some_and(|selected| selected.contains(&choices[0])) {
                choices.clear();
            }
        }
        let multiple = if parameter["_explicit_single"] == true {
            false
        } else {
            parameter["multiple"].as_bool().unwrap_or(false)
                || form.is_some_and(|form| form.multiple)
        };
        parameter["choices"] = if choices.is_empty() {
            Value::Null
        } else {
            json!(choices)
        };
        parameter["multiple"] = json!(multiple);
        parameter["options_state"] = json!(if choices.is_empty() {
            "unavailable"
        } else {
            "ready"
        });
        if let Some(form) = form.filter(|form| !form.selected.is_empty()) {
            parameter["default"] = if multiple {
                json!(form.selected)
            } else {
                json!(form.selected[0])
            };
        }
    }
    hidden_values
}

fn apply_active_choice_bindings(
    parameters: &mut [Value],
    bindings: &BTreeMap<String, ActiveChoiceBinding>,
) {
    for parameter in parameters {
        let name = parameter["name"].as_str().unwrap_or_default();
        if let Some(binding) = bindings.get(name) {
            parameter["references"] = json!(binding.references);
        }
    }
}

fn active_choice_reference_values(
    parameters: &[Value],
    forms: &BTreeMap<String, BuildFormParameter>,
    submitted: &BTreeMap<String, Value>,
) -> BTreeMap<String, Value> {
    let mut values = BTreeMap::new();
    for parameter in parameters {
        let name = parameter["name"].as_str().unwrap_or_default();
        if let Some(value) = submitted.get(name) {
            values.insert(name.to_owned(), value.clone());
        } else if let Some(form) = forms.get(name).filter(|form| !form.selected.is_empty()) {
            values.insert(
                name.to_owned(),
                if parameter["multiple"] == true {
                    json!(form.selected)
                } else {
                    json!(form.selected[0])
                },
            );
        } else if let Some(value) = parameter.get("default").filter(|value| {
            matches!(
                value,
                Value::String(_) | Value::Bool(_) | Value::Number(_) | Value::Array(_)
            )
        }) {
            values.insert(name.to_owned(), value.clone());
        }
    }
    values
}

fn active_choice_reference_value(value: Option<&Value>) -> String {
    match value {
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join(","),
        Some(Value::Bool(true)) => "true".into(),
        Some(Value::Bool(false)) | None => String::new(),
        Some(value @ (Value::String(_) | Value::Number(_))) => scalar(value),
        _ => String::new(),
    }
}

fn normalize_active_choice_response(
    payload: &Value,
    reference_only: bool,
) -> Option<(Vec<String>, Vec<String>)> {
    let payload = payload.as_array()?;
    let labels = payload.first()?.as_array()?;
    let values = payload.get(1)?.as_array()?;
    if labels.len() > MAX_BUILD_FORM_OPTIONS || values.len() > MAX_BUILD_FORM_OPTIONS {
        return None;
    }
    let mut choices = Vec::new();
    let mut selected = Vec::new();
    for (index, label) in labels.iter().enumerate() {
        let value = values.get(index).unwrap_or(label);
        let (label, label_selected, label_disabled) = normalize_active_choice_entry(label);
        let (value, value_selected, value_disabled) = normalize_active_choice_entry(value);
        let choice = if reference_only { label } else { value };
        if label_disabled
            || value_disabled
            || choice.is_empty()
            || choice.len() > MAX_PARAMETER_VALUE_LENGTH
            || choices.contains(&choice)
        {
            continue;
        }
        if label_selected || value_selected {
            selected.push(choice.clone());
        }
        choices.push(choice);
    }
    Some((choices, selected))
}

fn normalize_active_choice_entry(value: &Value) -> (String, bool, bool) {
    let mut value = match value {
        Value::String(value) => value.clone(),
        Value::Bool(_) | Value::Number(_) => scalar(value),
        _ => serde_json::to_string(value).unwrap_or_default(),
    };
    let mut selected = false;
    let mut disabled = false;
    loop {
        if value.ends_with(":selected") {
            value.truncate(value.len() - ":selected".len());
            selected = true;
        } else if value.ends_with(":disabled") {
            value.truncate(value.len() - ":disabled".len());
            disabled = true;
        } else {
            break;
        }
    }
    (value, selected, disabled)
}

fn fill_value_item_choices(payload: &Value) -> Vec<String> {
    if payload["errors"]
        .as_array()
        .is_some_and(|value| !value.is_empty())
        || payload["errors"]
            .as_str()
            .is_some_and(|value| !value.is_empty())
    {
        return Vec::new();
    }
    let Some(values) = payload["values"].as_array() else {
        return Vec::new();
    };
    if values.len() > MAX_BUILD_FORM_OPTIONS {
        return Vec::new();
    }
    let mut choices = Vec::new();
    for value in values {
        let Some(value) = value["value"].as_str() else {
            continue;
        };
        if value.len() <= MAX_PARAMETER_VALUE_LENGTH && !choices.iter().any(|item| item == value) {
            choices.push(value.to_owned());
        }
    }
    choices
}

fn jenkins_relative_endpoint(instance: &JenkinsInstance, path: &str) -> String {
    let context = Url::parse(&instance.base_url)
        .ok()
        .map(|url| url.path().trim_end_matches('/').to_owned())
        .unwrap_or_default();
    if !context.is_empty() && (path == context || path.starts_with(&format!("{context}/"))) {
        path[context.len()..].to_owned()
    } else {
        path.to_owned()
    }
}

fn make_job_detail_public(detail: &mut Value) {
    if let Some(fields) = detail.as_object_mut() {
        fields.retain(|key, _| !key.starts_with('_'));
    }
    if let Some(parameters) = detail["parameters"].as_array_mut() {
        parameters.retain(|parameter| parameter["type"] != "hidden");
        for parameter in parameters {
            if let Some(fields) = parameter.as_object_mut() {
                fields.retain(|key, _| !key.starts_with('_'));
            }
        }
    }
}

fn normalize_base_url(value: &str) -> AppResult<String> {
    if value.len() > 2_048 {
        return Err(AppError::bad_request(
            "Jenkins base URL must not exceed 2048 characters",
        ));
    }
    let mut url = Url::parse(value.trim())
        .map_err(|_| AppError::bad_request("Jenkins base URL is invalid"))?;
    if !matches!(url.scheme(), "http" | "https")
        || url.host_str().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(AppError::bad_request(
            "Jenkins base URL must be an uncredentialed HTTP or HTTPS URL",
        ));
    }
    let normalized_path = url.path().trim_end_matches('/').to_owned();
    url.set_path(&normalized_path);
    Ok(url.to_string().trim_end_matches('/').into())
}

fn required_token(token: Option<&str>) -> AppResult<&str> {
    let token = token
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| AppError::bad_request("Jenkins API token is required"))?;
    if token.len() > 4_096 {
        return Err(AppError::bad_request(
            "Jenkins API token must not exceed 4096 characters",
        ));
    }
    Ok(token)
}

fn ensure_unique_name(
    instances: &BTreeMap<String, JenkinsInstance>,
    name: &str,
    excluding: Option<&str>,
) -> AppResult<()> {
    if instances.values().any(|instance| {
        Some(instance.id.as_str()) != excluding && instance.name.eq_ignore_ascii_case(name)
    }) {
        return Err(AppError::conflict(format!(
            "Jenkins instance name already exists: {name}"
        )));
    }
    Ok(())
}

fn client_for(instance: &JenkinsInstance) -> AppResult<Client> {
    let mut builder = Client::builder()
        .timeout(Duration::from_secs_f64(instance.request_timeout))
        .redirect(reqwest::redirect::Policy::none())
        .cookie_store(true);
    if !instance.ca_bundle.is_empty() {
        let bytes = fs::read(expand_home(&instance.ca_bundle)).map_err(|error| {
            AppError::bad_request(format!("failed to read Jenkins CA bundle: {error}"))
        })?;
        builder = builder.add_root_certificate(reqwest::Certificate::from_pem(&bytes).map_err(
            |error| AppError::bad_request(format!("invalid Jenkins CA bundle: {error}")),
        )?);
    }
    builder
        .build()
        .map_err(|error| AppError::Internal(error.to_string()))
}

fn clean_job(value: &str) -> String {
    value.trim().trim_matches('/').into()
}
fn clean_required_job(value: &str) -> AppResult<String> {
    let value = clean_job(value);
    if value.is_empty() {
        Err(AppError::bad_request("Jenkins job is required"))
    } else {
        validate_job_path(&value)?;
        Ok(value)
    }
}

fn validate_job_path(value: &str) -> AppResult<()> {
    if value.len() > 1_000
        || value.split('/').any(|segment| {
            segment.is_empty()
                || matches!(segment, "." | "..")
                || segment.chars().any(|character| character.is_control())
        })
    {
        Err(AppError::bad_request("Jenkins job path is invalid"))
    } else {
        Ok(())
    }
}

fn validate_parameter_payload(parameters: &BTreeMap<String, Value>) -> AppResult<()> {
    if parameters.len() > 200 {
        return Err(AppError::bad_request(
            "at most 200 Jenkins build parameters are supported",
        ));
    }
    for (name, value) in parameters {
        if name.trim().is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
            return Err(AppError::bad_request(
                "Jenkins build parameter names must be printable and non-empty",
            ));
        }
        match value {
            Value::String(value) if value.len() <= MAX_PARAMETER_VALUE_LENGTH => {}
            Value::String(_) => {
                return Err(AppError::bad_request(
                    "Jenkins build parameter values must not exceed 16384 characters",
                ));
            }
            Value::Array(values) => {
                if values.len() > MAX_MULTI_SELECT_VALUES {
                    return Err(AppError::bad_request(
                        "Jenkins multi-select parameters must not exceed 5000 values",
                    ));
                }
                if values.iter().any(|value| {
                    value
                        .as_str()
                        .is_none_or(|value| value.len() > MAX_PARAMETER_VALUE_LENGTH)
                }) {
                    return Err(AppError::bad_request(
                        "Jenkins multi-select parameters must contain bounded strings",
                    ));
                }
            }
            Value::Bool(_) | Value::Number(_) => {}
            _ => {
                return Err(AppError::bad_request(
                    "Jenkins build parameters must be strings, numbers, booleans, or string lists",
                ));
            }
        }
    }
    Ok(())
}
fn job_path(job: &str) -> String {
    if job.is_empty() {
        String::new()
    } else {
        format!(
            "/{}",
            job.split('/')
                .map(|part| format!("job/{}", utf8_percent_encode(part, NON_ALPHANUMERIC)))
                .collect::<Vec<_>>()
                .join("/")
        )
    }
}

async fn response_json(response: Response) -> AppResult<Value> {
    response
        .json()
        .await
        .map_err(|error| AppError::conflict(format!("Jenkins returned invalid JSON: {error}")))
}
fn bounded(value: &str, size: usize) -> String {
    value.chars().take(size).collect()
}
fn job_status(color: &str) -> String {
    let color = color.to_ascii_lowercase();
    if color.ends_with("_anime") {
        "RUNNING".into()
    } else {
        match color.as_str() {
            "blue" | "green" => "SUCCESS",
            "red" => "FAILURE",
            "yellow" => "UNSTABLE",
            "aborted" => "ABORTED",
            "disabled" => "DISABLED",
            "notbuilt" => "NOT_BUILT",
            _ => "UNKNOWN",
        }
        .into()
    }
}

fn job_kind(value: &str) -> &'static str {
    let value = value.to_ascii_lowercase();
    if value.contains("folder")
        || value.contains("multibranch")
        || value.contains("organizationfolder")
    {
        "folder"
    } else if value.contains("workflowjob") {
        "pipeline"
    } else if value.contains("freestyle") {
        "freestyle"
    } else {
        "job"
    }
}

fn normalize_job(value: &Value, folder: &str) -> Value {
    let name = value["name"].as_str().unwrap_or_default();
    let full = value["fullName"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if folder.is_empty() {
                name.into()
            } else {
                format!("{folder}/{name}")
            }
        });
    let color = value["color"].as_str().unwrap_or_default();
    let last_build = value["lastBuild"]
        .as_object()
        .and_then(|_| normalize_build(&value["lastBuild"]))
        .filter(|build| build["number"].as_u64().is_some_and(|number| number > 0))
        .unwrap_or(Value::Null);
    json!({
        "name": name,
        "full_name": full,
        "url": value["url"].as_str().unwrap_or_default(),
        "kind": job_kind(value["_class"].as_str().unwrap_or_default()),
        "color": value.get("color").and_then(Value::as_str),
        "status": job_status(color),
        "buildable": value["buildable"].as_bool().unwrap_or(false),
        "in_queue": value["inQueue"].as_bool().unwrap_or(false),
        "last_build": last_build
    })
}

fn normalize_job_detail(
    value: &Value,
    job: &str,
    options_requested: bool,
    include_hidden: bool,
) -> Value {
    let mut normalized = normalize_job(
        value,
        job.rsplit_once('/').map(|(parent, _)| parent).unwrap_or(""),
    );
    let mut parameters = Vec::new();
    let mut names = std::collections::BTreeSet::new();
    let mut parameterized = false;
    for source in [value.get("property"), value.get("actions")]
        .into_iter()
        .flatten()
        .filter_map(Value::as_array)
        .flatten()
    {
        let Some(definitions) = source["parameterDefinitions"].as_array() else {
            continue;
        };
        parameterized = true;
        for definition in definitions {
            let name = definition["name"].as_str().unwrap_or_default().trim();
            if name.is_empty() || !names.insert(name.to_owned()) {
                continue;
            }
            let mut parameter = normalize_parameter(definition, options_requested);
            if include_hidden || parameter["type"] != "hidden" {
                if !include_hidden && let Some(fields) = parameter.as_object_mut() {
                    fields.retain(|key, _| !key.starts_with('_'));
                }
                parameters.push(parameter);
            }
        }
    }
    let requires_password = parameters.iter().any(|parameter| {
        parameter["_form_dynamic"].as_bool() == Some(true)
            && parameters
                .iter()
                .any(|candidate| candidate["type"] == "password")
    });
    normalized["parameters"] = Value::Array(parameters);
    normalized["parameterized"] = Value::Bool(parameterized);
    normalized["requires_explicit_password"] = Value::Bool(requires_password);
    normalized["description"] = value
        .get("description")
        .and_then(Value::as_str)
        .map_or(Value::Null, |value| json!(value));
    normalized
}

fn normalize_parameter(definition: &Value, options_requested: bool) -> Value {
    let raw = definition["type"]
        .as_str()
        .or_else(|| definition["_class"].as_str())
        .unwrap_or("StringParameterDefinition");
    let class = definition["_class"].as_str().unwrap_or(raw);
    let choice_type = definition["choiceType"].as_str().unwrap_or_default();
    let parameter_type = parameter_kind(class, raw, choice_type);
    let filesystem_list = [class, raw].iter().any(|value| is_filesystem_list(value));
    let active_choice = [class, raw].iter().any(|value| is_active_choice(value));
    let form_dynamic = parameter_type == "choice"
        && [class, raw, choice_type]
            .iter()
            .any(|value| is_form_dynamic(value) || is_active_choice(value));
    let dynamic_choice = parameter_type == "choice"
        && (form_dynamic
            || [class, raw]
                .iter()
                .any(|value| value.to_lowercase().contains("gitparameter")));
    let form_options =
        parameter_type == "choice" && (form_dynamic || dynamic_choice || active_choice);
    let explicit_single = [class, raw, choice_type]
        .iter()
        .any(|value| is_explicit_single(value));
    let choices = parameter_choices(definition);
    let options_state = if parameter_type != "choice" {
        "not_applicable"
    } else if !choices.is_empty() {
        "ready"
    } else if options_requested {
        "unavailable"
    } else {
        "not_loaded"
    };
    let default = if matches!(parameter_type, "password" | "hidden" | "separator") {
        Value::Null
    } else {
        definition["defaultParameterValue"]
            .get("value")
            .cloned()
            .unwrap_or(Value::Null)
    };
    let multiple = [class, raw, choice_type].iter().any(|value| {
        matches!(
            value.to_lowercase().rsplit('.').next().unwrap_or_default(),
            "pt_checkbox" | "pt_multi_select"
        )
    });
    let choices_value = if choices.is_empty() {
        Value::Null
    } else {
        json!(choices)
    };
    let mut parameter = json!({
        "name": definition["name"].as_str().unwrap_or(""),
        "type": parameter_type,
        "raw_type": raw,
        "description": definition.get("description").and_then(Value::as_str),
        "default": default,
        "choices": choices_value,
        "options_state": options_state,
        "multiple": multiple,
        "references": [],
        "_dynamic_choice": dynamic_choice,
        "_form_dynamic": form_dynamic,
        "_form_options": form_options || parameter_type == "reference",
        "_filesystem_list": filesystem_list,
        "_active_choice": active_choice,
        "_explicit_single": explicit_single,
    });
    if parameter_type == "separator" {
        parameter["header"] = json!(
            definition["sectionHeader"]
                .as_str()
                .or_else(|| definition["description"].as_str())
                .unwrap_or_default()
        );
    }
    parameter
}

fn parameter_kind<'a>(class: &'a str, raw: &'a str, choice_type: &'a str) -> &'static str {
    let candidates = [class, raw, choice_type].map(|value| {
        value
            .to_lowercase()
            .rsplit('.')
            .next()
            .unwrap_or_default()
            .to_owned()
    });
    if candidates
        .iter()
        .any(|value| value == "dynamicreferenceparameter")
    {
        "reference"
    } else if candidates.iter().any(|value| {
        value.ends_with("fileparameterdefinition") && value != "filesystemlistparameterdefinition"
    }) {
        "file"
    } else if candidates.iter().any(|value| {
        matches!(
            value.as_str(),
            "hiddenparameterdefinition" | "whideparameterdefinition"
        )
    }) {
        "hidden"
    } else if candidates
        .iter()
        .any(|value| value == "parameterseparatordefinition")
    {
        "separator"
    } else if candidates.iter().any(|value| value.contains("boolean")) {
        "boolean"
    } else if candidates.iter().any(|value| {
        value.contains("choice")
            || value.contains("gitparameter")
            || value == "filesystemlistparameterdefinition"
            || matches!(
                value.as_str(),
                "pt_checkbox" | "pt_multi_select" | "pt_radio" | "pt_single_select"
            )
    }) {
        "choice"
    } else if candidates.iter().any(|value| value.contains("password")) {
        "password"
    } else if candidates.iter().any(|value| value.contains("text")) {
        "text"
    } else if candidates
        .iter()
        .any(|value| value.contains("integer") || value.contains("number"))
    {
        "number"
    } else if candidates.iter().any(|value| value.contains("credential")) {
        "credentials"
    } else if candidates.iter().any(|value| value.contains("run")) {
        "run"
    } else {
        "string"
    }
}

fn is_form_dynamic(value: &str) -> bool {
    matches!(
        value.to_lowercase().rsplit('.').next().unwrap_or_default(),
        "filesystemlistparameterdefinition"
            | "choiceparameter"
            | "pt_checkbox"
            | "pt_multi_select"
            | "pt_radio"
            | "pt_single_select"
    )
}

fn is_filesystem_list(value: &str) -> bool {
    value
        .to_lowercase()
        .rsplit('.')
        .next()
        .is_some_and(|value| value == "filesystemlistparameterdefinition")
}

fn is_active_choice(value: &str) -> bool {
    matches!(
        value.to_lowercase().rsplit('.').next().unwrap_or_default(),
        "cascadechoiceparameter" | "dynamicreferenceparameter"
    )
}

fn is_explicit_single(value: &str) -> bool {
    matches!(
        value.to_lowercase().rsplit('.').next().unwrap_or_default(),
        "pt_radio" | "pt_single_select"
    )
}

fn parameter_choices(definition: &Value) -> Vec<String> {
    if definition["allValueItems"]["errors"]
        .as_array()
        .is_some_and(|errors| !errors.is_empty())
        || definition["allValueItems"]["errors"]
            .as_str()
            .is_some_and(|error| !error.is_empty())
    {
        return Vec::new();
    }
    let candidates: Vec<&Value> = if let Some(choices) = definition["choices"].as_array() {
        choices.iter().collect()
    } else {
        definition["allValueItems"]["values"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item.get("value"))
            .collect()
    };
    let mut seen = std::collections::BTreeSet::new();
    candidates
        .into_iter()
        .filter_map(Value::as_str)
        .filter(|value| seen.insert((*value).to_owned()))
        .map(str::to_owned)
        .collect()
}

fn validate_build_parameters(
    submitted: &BTreeMap<String, Value>,
    definitions: &[Value],
    parameterized: bool,
    hidden_values: &serde_json::Map<String, Value>,
) -> AppResult<(BTreeMap<String, Value>, bool)> {
    if !parameterized && !submitted.is_empty() {
        return Err(AppError::bad_request("Jenkins job is not parameterized"));
    }
    let by_name: BTreeMap<&str, &Value> = definitions
        .iter()
        .filter_map(|definition| Some((definition["name"].as_str()?, definition)))
        .collect();
    if let Some(name) = submitted
        .keys()
        .find(|name| !by_name.contains_key(name.as_str()))
    {
        return Err(AppError::bad_request(format!(
            "Jenkins parameter {name} is not defined for this job"
        )));
    }
    if let Some(definition) = definitions
        .iter()
        .find(|definition| matches!(definition["type"].as_str(), Some("file" | "unsupported")))
    {
        return Err(AppError::bad_request(format!(
            "Jenkins parameter type is not supported: {}",
            definition["name"].as_str().unwrap_or_default()
        )));
    }
    let mut result = BTreeMap::new();
    for (name, value) in submitted {
        let definition = by_name[name.as_str()];
        let parameter_type = definition["type"].as_str().unwrap_or("string");
        if matches!(parameter_type, "separator" | "reference" | "hidden")
            || (parameter_type == "password" && value.as_str() == Some(""))
        {
            continue;
        }
        let multiple = definition["multiple"].as_bool().unwrap_or(false);
        if multiple {
            let values = value.as_array().ok_or_else(|| {
                AppError::bad_request(format!(
                    "Jenkins multi-select parameter {name} must be a list"
                ))
            })?;
            if values.len() > MAX_MULTI_SELECT_VALUES
                || values.iter().any(|value| !value.is_string())
            {
                return Err(AppError::bad_request(format!(
                    "Jenkins multi-select parameter {name} is invalid"
                )));
            }
            let mut unique = Vec::new();
            for value in values {
                if !unique.contains(value) {
                    unique.push(value.clone());
                }
            }
            result.insert(name.clone(), Value::Array(unique));
        } else if value.is_array() {
            return Err(AppError::bad_request(format!(
                "Jenkins parameter {name} does not accept multiple values"
            )));
        } else if !matches!(value, Value::String(_) | Value::Bool(_) | Value::Number(_)) {
            return Err(AppError::bad_request(format!(
                "Jenkins parameter {name} must be a scalar value"
            )));
        }
        if definition["_dynamic_choice"].as_bool() == Some(true) {
            if definition["options_state"] != "ready" {
                return Err(AppError::bad_request(
                    "Jenkins dynamic parameter options are unavailable",
                ));
            }
            let choices = definition["choices"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            let selected = value
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![value.clone()]);
            if selected.iter().any(|value| !choices.contains(value)) {
                return Err(AppError::bad_request(format!(
                    "Jenkins parameter {name} is not one of the current choices"
                )));
            }
        }
        if !multiple {
            result.insert(name.clone(), value.clone());
        }
    }

    let dynamic_definitions: Vec<&Value> = definitions
        .iter()
        .filter(|definition| definition["_dynamic_choice"] == true)
        .collect();
    for definition in &dynamic_definitions {
        if definition["options_state"] != "ready" {
            return Err(AppError::bad_request(
                "Jenkins dynamic parameter options are unavailable",
            ));
        }
        let name = definition["name"].as_str().unwrap_or_default();
        let choices = definition["choices"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        if let Some(value) = result.get(name) {
            let selected = value
                .as_array()
                .cloned()
                .unwrap_or_else(|| vec![value.clone()]);
            if selected.iter().any(|value| !choices.contains(value)) {
                return Err(AppError::bad_request(format!(
                    "Jenkins parameter {name} is not one of the current choices"
                )));
            }
        } else if definition["_form_dynamic"] == true && !choices.is_empty() {
            let default = &definition["default"];
            if definition["multiple"] == true {
                let defaults = default
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter(|value| choices.contains(value))
                    .cloned()
                    .collect();
                result.insert(name.into(), Value::Array(defaults));
            } else {
                result.insert(
                    name.into(),
                    if choices.contains(default) {
                        default.clone()
                    } else {
                        choices[0].clone()
                    },
                );
            }
        }
    }

    let classic = definitions
        .iter()
        .any(|definition| definition["_form_dynamic"] == true);
    if classic {
        for definition in definitions {
            let name = definition["name"].as_str().unwrap_or_default();
            let parameter_type = definition["type"].as_str().unwrap_or("string");
            if parameter_type == "password" && !result.contains_key(name) {
                return Err(AppError::bad_request(format!(
                    "Jenkins password parameter {name} must be provided for dynamic builds"
                )));
            }
            if name.is_empty()
                || result.contains_key(name)
                || matches!(parameter_type, "hidden" | "separator" | "reference")
            {
                continue;
            }
            let default = &definition["default"];
            if matches!(
                default,
                Value::String(_) | Value::Number(_) | Value::Bool(_) | Value::Array(_)
            ) {
                result.insert(name.into(), default.clone());
            }
        }
    }

    let hidden_names: Vec<&str> = definitions
        .iter()
        .filter(|definition| definition["type"] == "hidden")
        .filter_map(|definition| definition["name"].as_str())
        .collect();
    if hidden_names
        .iter()
        .any(|name| !hidden_values.contains_key(*name))
    {
        return Err(AppError::conflict(
            "Jenkins hidden parameter defaults are unavailable",
        ));
    }
    for name in hidden_names {
        if let Some(Value::String(value)) = hidden_values.get(name) {
            result.insert(name.into(), json!(value));
        }
    }
    Ok((result, classic))
}

fn normalize_build(value: &Value) -> Option<Value> {
    let number = value["number"].as_u64()?;
    let building = value["building"].as_bool().unwrap_or(false);
    let result = value.get("result").cloned().unwrap_or(Value::Null);
    let status = if building {
        "RUNNING"
    } else {
        result.as_str().unwrap_or("UNKNOWN")
    };
    Some(json!({
        "number": number,
        "url": value["url"].as_str().unwrap_or_default(),
        "display_name": value["displayName"].as_str().unwrap_or_default(),
        "full_display_name": value["fullDisplayName"].as_str().unwrap_or_default(),
        "building": building,
        "result": result,
        "status": status,
        "timestamp": value.get("timestamp").filter(|value| value.is_number()).cloned(),
        "duration": value.get("duration").filter(|value| value.is_number()).cloned(),
        "estimated_duration": value.get("estimatedDuration").filter(|value| value.is_number()).cloned(),
        "queue_id": value.get("queueId").filter(|value| value.is_number()).cloned(),
        "description": value.get("description").and_then(Value::as_str)
    }))
}

fn normalize_queue(value: &Value) -> Option<Value> {
    let id = value["id"].as_u64()?;
    let task = value["task"].as_object().map(|task| {
        json!({
            "name": task.get("name").and_then(Value::as_str).unwrap_or_default(),
            "full_name": task.get("fullName").and_then(Value::as_str).or_else(|| task.get("name").and_then(Value::as_str)).unwrap_or_default(),
            "url": task.get("url").and_then(Value::as_str).unwrap_or_default(),
            "color": task.get("color").and_then(Value::as_str)
        })
    });
    let executable = value["executable"].as_object().map(|executable| {
        json!({
            "number": executable.get("number").filter(|value| value.is_number()).cloned(),
            "url": executable.get("url").and_then(Value::as_str).unwrap_or_default()
        })
    });
    Some(json!({
        "id": id,
        "url": value["url"].as_str().unwrap_or_default(),
        "blocked": value["blocked"].as_bool().unwrap_or(false),
        "buildable": value["buildable"].as_bool().unwrap_or(false),
        "stuck": value["stuck"].as_bool().unwrap_or(false),
        "why": value.get("why").and_then(Value::as_str),
        "task": task,
        "executable": executable
    }))
}

fn parameter_values(name: &str, value: &Value) -> Vec<(String, String)> {
    match value {
        Value::Array(values) => values
            .iter()
            .map(|value| (name.into(), scalar(value)))
            .collect(),
        _ => vec![(name.into(), scalar(value))],
    }
}
fn scalar(value: &Value) -> String {
    match value {
        Value::String(value) => value.clone(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use axum::{
        Router,
        body::{Body, to_bytes},
        extract::{Request, State},
        http::{Response as HttpResponse, StatusCode as HttpStatus},
        response::IntoResponse,
        routing::any,
    };
    use tokio::{net::TcpListener, sync::Mutex};

    #[test]
    fn base_url_rejects_credentials_and_job_path_encodes_segments() {
        assert!(normalize_base_url("https://user:secret@example.com").is_err());
        assert_eq!(job_path("folder/job name"), "/job/folder/job/job%20name");
    }

    #[test]
    fn loads_the_nullable_ca_bundle_written_by_python_releases() {
        let directory = tempfile::tempdir().unwrap();
        fs::write(
            directory.path().join("jenkins-instances.json"),
            serde_json::to_vec(&json!({
                "version": 1,
                "instances": [{
                    "id": "legacy",
                    "name": "Legacy Jenkins",
                    "base_url": "https://jenkins.example.test",
                    "username": "builder",
                    "ca_bundle": null,
                    "enabled": true,
                    "request_timeout": 15.0
                }]
            }))
            .unwrap(),
        )
        .unwrap();

        let service = JenkinsService::new(directory.path()).unwrap();
        assert_eq!(
            service
                .instances
                .blocking_read()
                .get("legacy")
                .unwrap()
                .ca_bundle,
            ""
        );
    }

    #[test]
    fn normalizes_static_and_git_parameters_without_leaking_secrets() {
        let payload = json!({
            "name": "release",
            "fullName": "release",
            "property": [{"parameterDefinitions": [
                {"name":"ENV","_class":"ChoiceParameterDefinition","choices":["dev","prod"],"defaultParameterValue":{"value":"dev"}},
                {"name":"PASSWORD","_class":"PasswordParameterDefinition","defaultParameterValue":{"value":"secret"}},
                {"name":"BRANCH","_class":"net.uaznia.lukanus.hudson.plugins.gitparameter.GitParameterDefinition","allValueItems":{"values":[{"value":"main"},{"value":"feature/api"}]},"defaultParameterValue":{"value":"main"}},
                {"name":"INTERNAL","_class":"WHideParameterDefinition","defaultParameterValue":{"value":"hidden"}}
            ]}]
        });

        let detail = normalize_job_detail(&payload, "release", true, false);
        let parameters = detail["parameters"].as_array().unwrap();
        assert_eq!(parameters.len(), 3);
        assert_eq!(parameters[0]["type"], "choice");
        assert_eq!(parameters[0]["default"], "dev");
        assert_eq!(parameters[1]["type"], "password");
        assert!(parameters[1]["default"].is_null());
        assert_eq!(parameters[2]["choices"], json!(["main", "feature/api"]));
        assert_eq!(parameters[2]["options_state"], "ready");
        assert!(
            parameters
                .iter()
                .all(|value| value.get("_dynamic_choice").is_none())
        );
        assert_eq!(detail["parameterized"], true);
    }

    #[test]
    fn dynamic_parameter_submission_uses_classic_form_after_resolution() {
        let definitions = vec![json!({
            "name": "ARTIFACT",
            "type": "choice",
            "multiple": false,
            "choices": ["a.zip"],
            "options_state": "ready",
            "_dynamic_choice": true,
            "_form_dynamic": true
        })];
        let submitted = BTreeMap::from([("ARTIFACT".into(), json!("a.zip"))]);
        let (validated, classic) =
            validate_build_parameters(&submitted, &definitions, true, &serde_json::Map::new())
                .unwrap();
        assert_eq!(validated, submitted);
        assert!(classic);
    }

    #[test]
    fn rejects_unbounded_or_structured_parameter_payloads_before_network_access() {
        let too_many = (0..201)
            .map(|index| (format!("P{index}"), json!("value")))
            .collect();
        assert!(validate_parameter_payload(&too_many).is_err());

        let nested = BTreeMap::from([("CONFIG".into(), json!({"secret": "value"}))]);
        assert!(validate_parameter_payload(&nested).is_err());

        let valid = BTreeMap::from([
            ("ENV".into(), json!("dev")),
            ("FLAGS".into(), json!(["one", "two"])),
            ("RETRIES".into(), json!(3)),
        ]);
        assert!(validate_parameter_payload(&valid).is_ok());
    }

    #[test]
    fn bounded_build_form_extracts_expected_options_hidden_values_and_bindings() {
        let html = r#"
          <div name="parameter"><input name="name" value="IGNORED"><select name="value"><option>leak</option></select></div>
          <form method="post" name="parameters" action="build">
            <div name="parameter">
              <input type="hidden" name="name" value="ARTIFACT">
              <select name="value" multiple>
                <option value="a.zip" selected>A</option>
                <option value="a.zip">duplicate</option>
                <option value="disabled.zip" disabled>disabled</option>
                <option>b.zip</option>
              </select>
            </div>
            <div name="parameter">
              <input type="hidden" name="name" value="INTERNAL_TOKEN">
              <input type="hidden" name="value" value="server-only">
            </div>
            <script>
              var referencedParameters = Array();
              referencedParameters.push("ARTIFACT");
              var proxy = makeStaplerProxy('/$stapler/bound/machine-binding','binding-crumb',['getChoicesForUI','doUpdate']);
              var cascade = new UnoChoice.CascadeParameter('MACHINE', document.body, 'choice-machine', proxy);
            </script>
          </form>
        "#;
        let expected = BTreeSet::from([
            "ARTIFACT".to_owned(),
            "INTERNAL_TOKEN".to_owned(),
            "MACHINE".to_owned(),
        ]);
        let snapshot = parse_build_form(html, &expected, "https://ci/job/api/build".into());
        let artifact = &snapshot.parameters["ARTIFACT"];
        assert_eq!(artifact.choices, Some(vec!["a.zip".into(), "b.zip".into()]));
        assert_eq!(artifact.selected, vec!["a.zip"]);
        assert!(artifact.multiple);
        assert_eq!(
            snapshot.parameters["INTERNAL_TOKEN"].hidden_value,
            Some("server-only".into())
        );
        let binding = &snapshot.active_choices["MACHINE"];
        assert_eq!(binding.references, vec!["ARTIFACT"]);
        assert_eq!(binding.endpoint, "/$stapler/bound/machine-binding");
        assert_eq!(binding.crumb, "binding-crumb");
    }

    #[test]
    fn form_resolution_preserves_selected_filesystem_value_and_hidden_default() {
        let mut parameters = vec![
            json!({
                "name":"ARTIFACT", "type":"choice", "multiple":false,
                "_form_options":true, "_filesystem_list":true,
                "_explicit_single":false, "options_state":"unavailable"
            }),
            json!({"name":"TOKEN", "type":"hidden"}),
        ];
        let forms = BTreeMap::from([
            (
                "ARTIFACT".into(),
                BuildFormParameter {
                    choices: Some(vec!["only.zip".into()]),
                    selected: vec!["only.zip".into()],
                    has_select: true,
                    ..BuildFormParameter::default()
                },
            ),
            (
                "TOKEN".into(),
                BuildFormParameter {
                    hidden_value: Some("server-only".into()),
                    has_hidden_value: true,
                    ..BuildFormParameter::default()
                },
            ),
        ]);
        let hidden = merge_build_form_parameters(&mut parameters, &forms);
        assert_eq!(parameters[0]["choices"], json!(["only.zip"]));
        assert_eq!(parameters[0]["default"], "only.zip");
        assert_eq!(hidden["TOKEN"], "server-only");
    }

    #[derive(Default)]
    struct DynamicMockState {
        update_values: Mutex<Vec<String>>,
        classic_payloads: Mutex<Vec<Value>>,
    }

    async fn dynamic_mock(
        State(state): State<Arc<DynamicMockState>>,
        request: Request,
    ) -> impl IntoResponse {
        let method = request.method().clone();
        let path = request.uri().path().to_owned();
        let headers = request.headers().clone();
        let body = to_bytes(request.into_body(), MAX_BUILD_FORM_BYTES)
            .await
            .unwrap();
        let json_response = |status, value: Value| {
            HttpResponse::builder()
                .status(status)
                .header("content-type", "application/json")
                .body(Body::from(value.to_string()))
                .unwrap()
        };
        match (method.as_str(), path.as_str()) {
            ("GET", "/job/api/api/json") => json_response(
                HttpStatus::OK,
                json!({
                    "name":"api", "fullName":"api",
                    "actions":[{"parameterDefinitions":[
                        {
                            "name":"ENV", "type":"PT_SINGLE_SELECT",
                            "_class":"ExtendedChoiceParameterDefinition",
                            "defaultParameterValue":{"value":"dev"}
                        },
                        {
                            "name":"MACHINE", "type":"CascadeChoiceParameter",
                            "_class":"org.biouno.unochoice.CascadeChoiceParameter",
                            "defaultParameterValue":{"value":"ERROR"}
                        }
                    ]}]
                }),
            ),
            ("GET", "/job/api/build") => HttpResponse::builder()
                .status(HttpStatus::METHOD_NOT_ALLOWED)
                .header("content-type", "text/html")
                .body(Body::from(
                    r#"<form method="post" name="parameters" action="build">
                      <div name="parameter"><input name="name" value="ENV"><select name="value"><option value="dev" selected>dev</option><option value="prod">prod</option></select></div>
                      <div name="parameter"><input name="name" value="MACHINE"><select name="value"></select></div>
                      <script>
                        var referencedParameters = Array(); referencedParameters.push("ENV");
                        var proxy = makeStaplerProxy('/$stapler/bound/machine-binding','binding-crumb',['getChoicesForUI','doUpdate']);
                        var cascade = new UnoChoice.CascadeParameter('MACHINE', document.body, 'choice-machine', proxy);
                      </script>
                    </form>"#,
                ))
                .unwrap(),
            ("POST", "/$stapler/bound/machine-binding/doUpdate") => {
                assert_eq!(headers.get("crumb").unwrap(), "binding-crumb");
                let values: Vec<String> = serde_json::from_slice(&body).unwrap();
                state.update_values.lock().await.push(values[0].clone());
                HttpResponse::builder()
                    .status(HttpStatus::NO_CONTENT)
                    .body(Body::empty())
                    .unwrap()
            }
            ("POST", "/$stapler/bound/machine-binding/getChoicesForUI") => {
                let update = state.update_values.lock().await.last().cloned().unwrap();
                let environment = update.split_once('=').unwrap().1;
                let values = vec![
                    format!("{environment}-a:selected"),
                    format!("{environment}-b"),
                ];
                json_response(HttpStatus::OK, json!([values, values]))
            }
            ("GET", "/crumbIssuer/api/json") => json_response(
                HttpStatus::OK,
                json!({"crumbRequestField":"Jenkins-Crumb", "crumb":"classic-crumb"}),
            ),
            ("POST", "/job/api/build") => {
                assert_eq!(headers.get("jenkins-crumb").unwrap(), "classic-crumb");
                let form: BTreeMap<String, String> =
                    url::form_urlencoded::parse(&body).into_owned().collect();
                state
                    .classic_payloads
                    .lock()
                    .await
                    .push(serde_json::from_str(&form["json"]).unwrap());
                HttpResponse::builder()
                    .status(HttpStatus::CREATED)
                    .header("location", "/queue/item/42/")
                    .body(Body::empty())
                    .unwrap()
            }
            _ => HttpResponse::builder()
                .status(HttpStatus::NOT_FOUND)
                .body(Body::from(format!("unexpected {method} {path}")))
                .unwrap(),
        }
    }

    #[tokio::test]
    async fn dynamic_choices_refresh_dependencies_and_trigger_one_classic_build() {
        let mock_state = Arc::new(DynamicMockState::default());
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let address = listener.local_addr().unwrap();
        let router = Router::new()
            .fallback(any(dynamic_mock))
            .with_state(mock_state.clone());
        let server = tokio::spawn(async move { axum::serve(listener, router).await.unwrap() });

        let directory = tempfile::tempdir().unwrap();
        let service = JenkinsService::new(directory.path()).unwrap();
        let instance = JenkinsInstance {
            id: "mock".into(),
            name: "Mock".into(),
            base_url: format!("http://{address}"),
            username: "developer".into(),
            ca_bundle: String::new(),
            enabled: true,
            request_timeout: 5.0,
        };
        service
            .instances
            .write()
            .await
            .insert(instance.id.clone(), instance);
        service
            .session_tokens
            .write()
            .await
            .insert("mock".into(), "secret-token".into());

        let prepared = service.get_job("mock", "api", true, None).await.unwrap();
        let refreshed_values = BTreeMap::from([("ENV".into(), json!("prod"))]);
        let refreshed = service
            .get_job("mock", "api", true, Some(&refreshed_values))
            .await
            .unwrap();
        let queued = service
            .trigger_build(
                "mock",
                "api",
                &BTreeMap::from([
                    ("ENV".into(), json!("prod")),
                    ("MACHINE".into(), json!("prod-b")),
                ]),
            )
            .await
            .unwrap();

        assert_eq!(
            prepared["parameters"][1]["choices"],
            json!(["dev-a", "dev-b"])
        );
        assert_eq!(prepared["parameters"][1]["references"], json!(["ENV"]));
        assert_eq!(
            refreshed["parameters"][1]["choices"],
            json!(["prod-a", "prod-b"])
        );
        assert_eq!(queued["id"], 42);
        assert_eq!(
            *mock_state.update_values.lock().await,
            vec!["ENV=dev", "ENV=prod", "ENV=prod"]
        );
        assert_eq!(
            *mock_state.classic_payloads.lock().await,
            vec![json!({"parameter":[
                {"name":"ENV", "value":"prod"},
                {"name":"MACHINE", "value":"prod-b"}
            ]})]
        );
        server.abort();
    }
}
