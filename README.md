# finance-mcp-server

Tek bir MCP server üzerinden **Instana**, **GitLab**, **Grafana**, **Jira** ve **Kubernetes**.
Lokalde stdio transport ile çalışır; API key'lerin makineni terk etmez.

Varsayılan olarak **salt okunur**. Yazma işlemleri servis bazında `.env` içinden ayrı ayrı açılır.

---

## Hızlı başlangıç

```bash
cd ~/Desktop/finance-mcp-server
cp .env.example .env
# .env dosyasını doldur (aşağıdaki tabloya bak)
npm install
npm run build
npm run doctor      # her servisin bağlantısını ve token'ını doğrular
```

`doctor` her entegrasyon için PASS/FAIL basar. Buradan temiz geçmeden Claude'a bağlamana gerek yok —
hata mesajları burada çok daha okunaklı.

---

## Token'ları nereden alacaksın

| Servis | Zorunlu değişkenler | Token nereden |
|---|---|---|
| Instana | `INSTANA_BASE_URL`, `INSTANA_API_TOKEN` | Instana UI → Settings → API Tokens. Base URL tenant unit adresin: `https://<tenant>-<unit>.instana.io` |
| GitLab | `GITLAB_BASE_URL`, `GITLAB_TOKEN` | User Settings → Access Tokens. Scope: `read_api` (yazma için `api`) |
| Grafana | `GRAFANA_BASE_URL`, `GRAFANA_TOKEN` | Administration → Service accounts → Add service account token |
| Jira Cloud | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_API_TOKEN` | https://id.atlassian.com/manage-profile/security/api-tokens |
| Jira Server/DC | `JIRA_BASE_URL`, `JIRA_API_TOKEN` | Profile → Personal Access Tokens. `JIRA_EMAIL` **boş bırak** |
| Kubernetes | `K8S_ENABLED=true` | Token yok — mevcut kubeconfig'ini kullanır |

Bir servisin zorunlu değişkenleri yoksa o entegrasyon hiç kaydedilmez. Yani tool listesi her zaman
gerçekten erişilebilir olanı gösterir. Hangilerinin aktif olduğunu görmek için `finance_status` tool'unu çağır.

`.env` gitignore'da. Gerçek token'ları asla commit'leme.

---

## Claude'a bağlama

### Claude Desktop

`~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "finance": {
      "command": "node",
      "args": ["/Users/adem.tacyildiz/Desktop/finance-mcp-server/dist/index.js"]
    }
  }
}
```

Kaydettikten sonra Claude Desktop'ı tamamen kapatıp yeniden aç.

### Claude Code

```bash
claude mcp add finance -- node /Users/adem.tacyildiz/Desktop/finance-mcp-server/dist/index.js
```

### Geliştirirken

```bash
npm run dev       # tsx watch — kaynak değişince yeniden başlar
npm run inspect   # MCP Inspector ile tool'ları elle dene
npm run verify    # self-check: tool sayıları, yazma kapıları, kubectl argüman koruması
```

---

## Tool'lar

Salt okunur modda **44 tool**; tüm yazma bayrakları açıkken **52**. Hangi entegrasyonun aktif
olduğunu ve yazmanın açık olup olmadığını `finance_status` tool'u söyler.

### Instana (7)
`instana_health` · `instana_list_events` · `instana_list_applications` · `instana_list_services` ·
`instana_search_snapshots` · `instana_get_application_metrics` · `instana_api_get`

`instana_api_get` bir kaçış kapısı: dedicated tool'u olmayan herhangi bir Instana endpoint'ine
salt okunur GET atar. Tam liste: https://instana.github.io/openapi/

### GitLab (12 + 2 yazma)
`gitlab_whoami` · `gitlab_search_projects` · `gitlab_get_project` · `gitlab_list_pipelines` ·
`gitlab_get_pipeline` · `gitlab_get_job_log` · `gitlab_list_merge_requests` · `gitlab_get_merge_request` ·
`gitlab_list_commits` · `gitlab_get_file` · `gitlab_list_issues` · `gitlab_search`
→ `GITLAB_ALLOW_WRITE=true` ile: `gitlab_retry_pipeline` · `gitlab_cancel_pipeline`

`gitlab_get_job_log` ANSI renk kodlarını temizler ve varsayılan olarak son 200 satırı döner —
hata neredeyse her zaman logun sonundadır ve tam log context'i boğar.

### Grafana (9)
`grafana_health` · `grafana_list_datasources` · `grafana_search_dashboards` · `grafana_get_dashboard` ·
`grafana_list_folders` · `grafana_query_prometheus` · `grafana_query` · `grafana_list_alert_rules` ·
`grafana_list_firing_alerts`

PromQL sorguları Grafana'nın datasource proxy'si üzerinden gider — yani Prometheus'a ayrıca
credential vermen gerekmez, Grafana'nın kayıtlı bağlantısı kullanılır. Loki/Elasticsearch/SQL için
`grafana_query` (generic `/api/ds/query`) var.

### Jira (6 + 3 yazma)
`jira_myself` · `jira_list_projects` · `jira_search_issues` · `jira_count_issues` · `jira_get_issue` ·
`jira_list_transitions`
→ `JIRA_ALLOW_WRITE=true` ile: `jira_add_comment` · `jira_transition_issue` · `jira_create_issue`

### Kubernetes (9 + 3 yazma)
`k8s_contexts` · `k8s_api_resources` · `k8s_get` · `k8s_describe` · `k8s_logs` · `k8s_logs_by_selector` ·
`k8s_events` · `k8s_top` · `k8s_rollout_status`
→ `K8S_ALLOW_WRITE=true` ile: `k8s_rollout_restart` · `k8s_scale` · `k8s_delete_pod`

---

## Tasarım kararları

**Kubernetes `kubectl` üzerinden konuşur, client kütüphanesi ile değil.**
`@kubernetes/client-node` yerine `execFile` ile `kubectl` çağrılır. Böylece terminalinde çalışan
kubeconfig, context ve auth plugin'leri (OIDC, exec credential plugin'leri, cloud provider auth)
birebir aynı şekilde çalışır — yeniden implement edilmez. Yan fayda: bir tool'un döndürdüğü her
çıktıyı aynı komutu terminalde çalıştırıp doğrulayabilirsin.

Shell kullanılmadığı için komut enjeksiyonu mümkün değil. Geriye kalan risk *flag* enjeksiyonudur —
resource adı olarak gelen `--kubeconfig=/tmp/evil` gibi bir değerin kubectl tarafından opsiyon olarak
okunması. Bu yüzden argv'ye giren her değer (isim, namespace, selector, süre) önce doğrulanır.

**Jira Cloud ve Server/DC otomatik ayırt edilir.**
Base URL `*.atlassian.net` ise Cloud kabul edilip API v3 + Basic auth (`email:token`) + Atlassian
Document Format kullanılır; değilse Server/DC kabul edilip API v2 + Bearer PAT + düz metin kullanılır.
Eski `/rest/api/3/search` endpoint'i Cloud'da kaldırıldı ve artık `410 Gone` dönüyor, bu yüzden
arama `/rest/api/3/search/jql` üzerinden ve `nextPageToken` ile sayfalanır.

**Salt okunur varsayılan.**
Her yazma tool'u kendi `*_ALLOW_WRITE` bayrağının arkasında ve bayrak kapalıyken tool hiç kaydedilmez —
yani Claude onu göremez bile. Yazma tool'ları ayrıca MCP `annotations` ile işaretlidir, istemci
onay isterken bunu kullanır.

**Sonuçlar kırpılır.**
`MAX_RESULT_CHARS` (varsayılan 60.000) tek bir tool sonucunu sınırlar. Filtresiz bir
`kubectl get -o json` veya büyük bir Grafana dashboard'u aksi halde context'i doldurur.

**stdout kutsaldır.**
stdio transport'ta stdout sadece JSON-RPC taşır. Tüm loglar stderr'e gider ve dotenv `quiet`
modda yüklenir — aksi halde bastığı tek bir satır protokolü bozardı.

---

## Sorun giderme

| Belirti | Sebep |
|---|---|
| Tool listesinde bir servis yok | Zorunlu env değişkenleri eksik. `finance_status` çağır veya `npm run doctor` çalıştır |
| `401` / `403` | Token yanlış veya scope yetersiz |
| Kubernetes tool'ları `connection refused` | kubeconfig'de context yok. `kubectl config get-contexts` ile kontrol et |
| Jira `410 Gone` | Eski search endpoint'i. Bu server zaten `/search/jql` kullanır; `JIRA_API_VERSION` elle `2`'ye sabitlenmişse kaldır |
| Claude server'ı görmüyor | `npm run build` çalıştırdın mı? `dist/index.js` var mı? Claude Desktop tamamen yeniden başlatıldı mı? |
| Değişiklik yansımıyor | `npm run build` sonrası Claude Desktop'ı yeniden başlat |

Server loglarını görmek için:
```bash
tail -f ~/Library/Logs/Claude/mcp-server-finance.log
```
