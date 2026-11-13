# EPCSE — المعمارية وخطة التكامل

**مسودة تصميم لا تنفيذ.** [المواصفة](product-spec.md) تقول ماذا، و[العقود](technical-contracts.md) كيف تتكامل الأجزاء، و[المهام](tasks.md) تبين ترتيب الأدلة. قرارات المصدر منفصلة عن اقتراحاتنا في [ADR](decisions.md). لا كود موجود يُعاد هيكلته.

## 1. السياق التقني ومراجعة المبادئ

| المحور | المرجع / المقترح |
|---|---|
| اللغة والتشغيل | TypeScript strict وNode.js؛ إصدارات Node/TS/pnpm والمكتبات الدقيقة تثبت في T02 بعد الإذن، لا ندعي تثبيتها |
| بنية التسليم | Modular Monolith، pnpm Workspaces، مكتبة محرك + CLI أولًا؛ تطبيق API ثم Web لاحقًا داخل **المشروع نفسه** |
| التحقق والاختبار | Zod مبكرًا، Vitest، ESLint/Prettier؛ مولد خصائص محلي حتمي أو مكتبة بعد تبرير واعتماد، لا تبعية مخترعة لازمة |
| التخزين | نواة في الذاكرة، codec مستقل عن I/O؛ PostgreSQL/Drizzle بعد إثبات النواة؛ snapshot دوري وسجل تجارب/أوامر، لا افتراض event sourcing كامل |
| التقديم اللاحق | Fastify؛ React/Vite وTailwind/shadcn، PixiJS لخريطة 2D، ECharts للمقاييس، Playwright للمتصفح؛ WebSocket عند الحاجة فقط |
| التشغيل والتحقق المتكرر | CI بـGitHub Actions مبكرًا عند الإذن؛ Docker Compose عند تعدد الخدمات. لا خدمة/تثبيت/شبكة/عمليات git في التكليف الحالي |
| الأداء | أهداف سعة M1: 3/12/15/6/5/4؛ قياس 1000 Tick. رقم سرعة وذاكرة مقبول يحتاج Q10 بعد VS والجهاز الفعلي |
| غير مطلوب | Microservices/Kubernetes/Redis/LLM داخل Tick؛ Worker Threads وRust/WASM فقط بعد قياس واعتماد مستقل |

لا يوجد دستور مشروع آخر نبتكره. فحص مبادئ المصدر قبل التنفيذ وبعد كل تكامل:

- استيراد النواة وتشغيلها في اختبار بلا HTTP/React/DB، ولا آثار جانبية عند import.
- لا ساعة نظام/Math.random/شبكة/IO في انتقال الحالة؛ RNG وترتيب ثابتان.
- الدفاتر تحفظ الأموال والموارد والسكان مع تحويلات/مصادر/فواقد صريحة.
- كل تغيير معلوم المالك، أوامر غير صالحة لا تترك أثرًا جزئيًا.
- سجل السبب والأثر ومقاييس النواة غير مختلط مع قياس الزمن الحقيقي.
- لا استخراج حزمة لمجرد اسم قطاع؛ واجهة فقط عند حد سياسة/تفصيل أو seam اختبار مفيد.

أي إخفاق في invariants يمنع تقدم التكامل؛ لا يعالج بتخفيف الاختبار أو hard-coded نتائج السيناريو.

## 2. حدود الطبقات واتجاه التبعيات

```text
CLI controller ───────────────┐
API controller (لاحقًا) ──────┼──► SimulationService / Engine
                             │       │
Web ui → state → api → transport      ├──► services/{economy,production,...}
      (عبر API فقط)                  ├──► models + shared الحسابية
                                     └──► ports (snapshot/run store) عند الحفظ
Persistence repositories ─────────────────► ports + codec
API/Web shared DTO/schema ◄── API mapping؛ لا كيانات mutable مشتركة
config/composition roots ──► تربط concretes، لا تتخذ قرارًا اقتصاديًا
```

- **services:** قواعد السوق/الإنتاج/السكان/الحكم، مستقلة عن HTTP/SQL/DOM. كل خدمة تحسب خطة أثر typed، ولا تحصل على مؤشر تعديل لحالة خدمة أخرى. المنسق يتحقق ويطبق الخطط في ترتيب موثق.
- **models:** أشكال ثابتة ومعرفات ووحدات وعقود؛ مالك الحالة وحده يغيرها. فئة Engine تغلف state/PRNG/queue وتكشف واجهات صغيرة. التحويلات النقية يمكن أن تبقى دوال؛ لا فرض OOP على كل صيغة.
- **controllers:** قراءة المدخل واستدعاء خدمة واحدة وتشكيل الاستجابة؛ لا قرار ضريبي/تسعير فيها. API قد يتحقق من الشكل والصلاحية، والنواة تبقى سلطة قواعد المجال.
- **repositories:** تفاصيل ملفات/SQL وحفظ ذري خلف ports؛ لا قواعد اقتصاد أو ORM في signatures النواة.
- **transport:** تفاصيل HTTP/WS وإعادة الاتصال؛ لا معنى اقتصادي. لا `clients/` افتراضيًا: لا خدمات خارجية مطلوبة الآن.
- **config:** تركيب الخدمات وتحميل الإعدادات عند الحدود؛ لا اتصال أو مؤقت عند import.
- **shared داخل النواة:** وحدات حسابية/أنواع أخطاء وأدوات بلا اعتماد على خدمات أو I/O؛ ليست مخزنًا عامًا.
- **عقد API:** `packages/contracts` لاحقًا هو seam API/Web فقط؛ لا خلطه مع shared الحسابية. فصل DTO عندما يختلف العرض/الحماية فعليًا عن النموذج، لا نسخ متطابقة لكل طبقة.

تطبيق مفيد لـSOLID: سبب تغير قواعد الاقتصاد مختلف عن مخطط PostgreSQL أو UI؛ واجهات ضيقة لـClock التشغيلي/RunStore/SnapshotStore، واعتماد عكسي على تلك العقود. لا نظام plugins أو bus موزع أو طبقة domain إضافية لمجرد الامتثال. اسم `domain/` في §10.1 مقترح؛ نقل العقود إلى models في البداية **اقتراح ADR-01** لا تغيير متطلبات.

## 3. خريطة المسارات المستهدفة

كل المسارات البرمجية التالية **مقترحة وغير موجودة الآن**. هذه مجموعة الملفات المتوقعة عبر المشروع، لا إنشاء جميع الحزم في أول دفعة.

```text
apps/
  cli/src/{main.ts,controllers/run.ts,config/wiring.ts}
  api/src/{controllers/,services/,transport/,middleware/,config/}
  web/src/{ui/,state/,api/,transport/,shared/}
packages/
  simulation-core/src/
    models/{world.ts,commands.ts,events.ts,units.ts}
    services/{engine.ts,phases.ts,scheduler.ts,rng.ts,codec.ts}
    services/{accounting/,production/,economy/,population/,logistics/}
    services/{cities/,firms/,agents/,government/,politics/,diplomacy/}
    ports/{snapshot-store.ts,run-store.ts}
    shared/{integer.ts,canonical.ts,errors.ts}
  scenarios/src/{initial-two-cities.ts,vertical-slice.ts,three-nations-trade-and-politics.ts,SC-01.ts,...,SC-17.ts}
  analytics/src/{projections.ts,queries.ts,compare.ts}
  persistence/src/{repositories/,schema/,migrations/}
  contracts/src/{worlds.ts,commands.ts,runs.ts,metrics.ts,events.ts,snapshots.ts}
tests/
  {unit/,property/,contract/,integration/,scenarios/,performance/,api/,e2e/}
docs/
  {README.md,product-spec.md,architecture.md,technical-contracts.md,tasks.md,scenarios.md,delegation.md,decisions.md}
```

بدءًا بثلاث حزم/تطبيقات §19: simulation-core + scenarios + cli، ثم analytics/persistence/contracts عند استعمالها. خدمات القدرات تبقى داخل النواة حتى يظهر سبب مقاس/بنيوي لاستخراجها. لا imports من simulation-core إلى persistence أو analytics أو تطبيقات العرض. analytics يقرأ أحداث/واجهات قراءة لا يملك تعديل النواة. `models/` ملفات مشتركة ذات مالك مركزي؛ بقية العمال يقترحون تغييرات عقود ولا يكتبونها بالتوازي.

## 4. مسارات العمل والشرائح المتكاملة

| المسار | شرائح/مهام | دليل يفتح ما بعده |
|---|---|---|
| عقود ومراجعة | T00/T01 ثم T02 | قرارات الدفعة المعتمدة، schemas وحالات فشل/أمثلة صحيحة، أوامر تحقق موثقة |
| نواة حسابية | T03/T04، بالتوازي T05 | ترتيب Tick/queue وPRNG/codec ووحدات/دفاتر مثبتة؛ اختبار invalid بلا أثر |
| اقتصاد S0 | T06 وT07 ثم T08 | 2 مدينة/3 سلع/100 Tick، تجارة فعلية وتقرير وتكرار وحفظ؛ S0 لا VS |
| VS متكامل | T09 ثم T10 | 2 دولة/2–4 مدن/5 سلع/1000 Tick، حكومتان ومجموعتان وتدخل اقتصادي ودبلوماسي، Gate A–C وإثبات D المبسط الممكن دون ادعاء اكتمال السياسة |
| تعميق M1 | T11/T12/T13/T14 بالتوازي المشروط؛ T15 ثم T16 | هجرة/بنية/منشآت/أشكال حكم/سياسة ودبلوماسية ثم 3/12/15/6/5/4؛ Gate D الكامل متعدد العوامل |
| حفظ وتحليل | T17 بعد VS، ثم T19 بعد M1 core | round-trip دائم واستمرار مماثل ومقارنة Snapshot 200 +100؛ Gate E |
| تقديم وتحكم | T18 بعد T16/T17؛ T20 بعد T18/T19؛ T21 | API وصلاحيات/تزامن ثم UI حقيقي لا mocks فقط؛ Gate F |
| مراجعة شاملة | T22 | DoD بكامل أدلته وSC-01–17 وسجل الاستثناءات وbenchmarks فعلية، دون وعد سرعة مسبق |
| بحث اختياري | T23 بإذن مستقل | تجربة محدودة بعد اختيار فرضية/قياس؛ لا شرط M1 |

هذه التبعيات لا تعني أن لكل نظام منتجًا منفصلًا؛ قبول الشريحة يثبت مسارًا عاملًا، ثم يبقى كل ما بعده في نطاق المشروع. سياسة الدمج: compile/focused test ثم integration السابق وdeterminism/invariants قبل قبول أي تغيير. التفاصيل في [دليل التفويض](delegation.md).

## 5. بوابات المصدر A–F وكيف لا نخلطها

- **A:** محرك headless + determinism + حفظ. S0 دليل مبكر 100 Tick، والتكامل VS يعيد ذلك لـ1000.
- **B:** إنتاج/استهلاك/سعر محلي متصل مع تقرير، لا دالة سعر منفردة.
- **C:** بين مدن، شحن مؤخر ورسوم وسعات؛ الطريق المرسوم ليس تجارة عاملة.
- **D:** صدمة اقتصادية قد تنتج أثرًا سياسيًا وفق عوامل/تنظيم وقرار مستقل. VS يختبر تدخلاته المحدودة، لكن لا يغلق D الكامل قبل T15/T16 وضابط عدم الإضراب الآلي.
- **E:** codec/snapshot في الذاكرة مبكرًا لعقد الاستمرار؛ التخزين الدائم T17 والمقارنة T19 يغلقان E، لا مجرد وجود method snapshot.
- **F:** UI تراقب وتطلب أوامر، والاقتصاد في النواة؛ الرحلة الفعلية T21 وليست mock API.

## 6. المخاطر والحد من التعقيد

| خطر المصدر §15 | تصميم/اختبار مخطط |
|---|---|
| اتساع النطاق وعدم الوصول للتشغيل | S0 ثم VS داخل النطاق الكامل، دون حذف الواجهة أو سياسة M1 |
| خلق موارد/نقد أو تكرار شحنة | دفتر تحويلات وconversion/loss مستقل، خصائص واختبارات فشل منتصف commit |
| سياسة مصطنعة/انحياز | معلومات محدودة وقواعد متعددة وfixtures قبول ورفض ومحايدة بين الأشكال |
| تذبذب سعر/انفجار عدد | وحدات صحيحة وتكميم وحدود تغير وقسمة آمنة ومعايرة معلنة النسخة |
| فقد التكرار | PRNG state وqueue وordering وhash canonical وحدود ضمان معلنة |
| بطء أو نسخ عالم كثيف | profiler خارج الحالة، دفعات وواجهات قراءة، copy-on-write/journal كاقتراح يثبت rollback أولًا |
| تسرب منطق إلى UI/DB | اختبارات imports/عقود ثم تشغيل الرأس بلا adapters واختبار متصفح فعلي |
| مبالغة في الواقعية | مقارنات اتجاهية مقيدة بالافتراضات، لا ربط بنتائج دول حقيقية |

لا يوجد دليل يبرر thread pool أو WASM أو event sourcing كامل الآن؛ T22 يقيس أولًا. تعقيد transaction journal مقترح لحماية الذرية؛ البديل الأبسط staging ثم swap مقبول إذا أثبت الأداء لاحقًا. الاختيار لا يُحسم بزعم أرقام غير مقاسة.
