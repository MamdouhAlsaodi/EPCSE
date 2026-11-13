# EPCSE — سجل المهام والتتبع

**مسودة غير معتمدة؛ جميع المهام غير منفذة.** المصدر [الأصل](reference/original-spec-ar.md) كاملًا، والنطاق [product-spec.md](product-spec.md). المشروع واحد؛ S0 وVS وM1 شرائح قبول متراكمة لا منتجات منفصلة. لا آجال تقويمية ولا إذن تنفيذ بهذه القائمة.

الوثائق المكملة الحالية: [السيناريوهات والاختبارات](scenarios.md)، [القرارات والعقود المقترحة](decisions.md)، [التفويض والتكامل](delegation.md)، [المعمارية](architecture.md). حُفظت الملفات السابقة دون تعديل؛ إحالاتها القديمة إلى `technical-contracts.md` و`adr/README.md` و`delegation-playbook.md` ليست ملفات موجودة: يقابلها الآن قسم العقود في decisions.md ثم decisions.md ثم delegation.md. تصحيح تلك الروابط يحتاج إذن تعديل الملفات المحفوظة، وليس شرطًا لاختراع وثائق إضافية.

## 1. قواعد القبول والملكية

- كل T أدناه تشمل النطاق والمخرج والقبول والاختبار؛ لا تُغلق لمجرد وجود الملفات. أدلة التحقق الفعلية مطلوبة لاحقًا.
- المسارات البرمجية **مستهدفة لا موجودة**؛ `core` اختصار `packages/simulation-core/src`، و`tests` تعني `tests/` من الجذر. الاختبارات إلزامية بحكم المصدر، ولو كانت اختيارية في قالب Spec Kit.
- المالك دور مقترح لا وكيل مفوض. المنسق يملك `models/` والعقود المشتركة و`services/phases.ts` وتركيب الوحدات وملفات الاختبار المشتركة. العمال يملكون مسارات خدماتهم واختباراتها فقط؛ لا كتابة متزامنة في ملف واحد.
- الدلالة `[P]` تعني قابلية توازٍ **بعد** اكتمال الاعتماديات وتثبيت العقد، لا استقلال المهمة عن المشروع. كل سؤال Q يعطل تفاصيله فقط؛ يسجل التعطيل ولا يُخمن جوابه.
- القبول المشترك: typecheck وlint والاختبار المحدد، ثم determinism وINV-01–10 وأقدم شريحة متكاملة تعمل. انكسار invariant يوقف التكامل، لا يبرر تخفيف الاختبار.

## 2. تأسيس وعقود — US1، أولوية P1

| ID / المالك / يعتمد على | النطاق والمخرجات المستهدفة | القبول والاختبارات المخططة |
|---|---|---|
| T00 / منسق / لا شيء | مراجعة هذه الوثائق والمصدر؛ فهرس التعارضات وتغطية FR/SC/DoD في docs/tasks.md وdocs/decisions.md | تسجيل Q01–Q10 كلها مفتوحة، لا موافقة منسوبة لممدوح؛ فحص الروابط والأرقام والأحجام وحفظ الأصل. هذه كتابة تخطيط وليست اجتياز بوابة R. |
| T01 / معماري + ممدوح / T00 | تثبيت عقود الدفعة في docs/decisions.md: وحدات، ترتيب، RNG، أوامر/أخطاء، snapshot، fixtures؛ فصل ما يحتاج قرار منتج عما يمكن اقتراحه | سجل اعتماد صريح للعقود اللازمة وQ02–Q06 قبل تنفيذ تفاصيل S0؛ أمثلة إدخال صحيح/فاشل وإيصالات أوامر. مراجعة ورقية، بلا تشغيل أو خدمات. |
| T02 / تأسيس / T01 + إذن تنفيذ | package.json وpnpm-workspace.yaml وtsconfig.json وإعدادات Vitest/ESLint/Prettier؛ تطبيق CLI وحزمتا core/scenarios؛ .github/workflows/ci.yml | TypeScript strict؛ scripts موثقة كما في scenarios.md؛ اختبار `tests/contract/imports.test.ts` يستورد النواة بلا I/O/DB/HTTP/React. إصدارات دقيقة وتبعيات مبررة بعد الإذن فقط. |
| T03 / نواة / T02 | core/models/{world,commands,events}.ts وservices/{engine,phases,scheduler}.ts: Config، step/run، queue وترتيب المراحل والأوامر | FR-01/11؛ حدود Tick ثابتة، stop/resume مكافئ run، ID ثابت، command غير صالح لا يغير شيئًا؛ `tests/contract/core.test.ts` و`tests/unit/scheduler.test.ts`، حقن فشل منتصف التطبيق. |
| T04 / تكرار / T03 | core/services/{rng,codec}.ts وshared/canonical.ts؛ snapshot/restore **في الذاكرة** وسجل أوامر | FR-01/12؛ حفظ كامل حالة PRNG/queue/IDs؛ restore ثم استمرار يطابق التشغيل المتصل؛ نسخ غير متوافقة مرفوضة بلا أثر؛ `tests/integration/{determinism,restore}.test.ts` و`tests/unit/codec.test.ts`. ليس تخزين PostgreSQL ولا إغلاق E. |
| T05 [P مع T03 ثم T04] / حساب / T02 وعقد T01 | core/models/units.ts وshared/integer.ts وservices/accounting/؛ دفاتر المال والمخزون والتحويل/التلف | FR-02؛ وحدات صحيحة مضبوطة، حجز/تحويل ذري وrollback، overflow/تقريب معلنان؛ `tests/unit/accounting.test.ts` و`tests/property/invariants.test.ts` (ملكية الأخير للمنسق). لا خلق موارد لإصلاح العجز. |

## 3. S0 ثم VS — US1/US2/US3، أولوية P1

| ID / المالك / يعتمد على | النطاق والمخرجات المستهدفة | القبول والاختبارات المخططة |
|---|---|---|
| T06 / اقتصاد محلي / T03–T05 + Q02/Q04/Q05 | core/services/{production,economy,population}/: وصفات/أجور/عمالة، احتياجات/شراء/استهلاك، سوق وسعر واحد الآلية | FR-02–05؛ إنتاج بأصغر قيد، ميزانية محدودة وتسوية صفقة مال/سلعة، نقص متراكم؛ `tests/unit/{production,market,population}.test.ts`؛ توقف عند فقد مدخل/سيولة، لا NaN في السوق الفارغ. |
| T07 [P مع T06] / نقل / T03–T05 + ADR-07 | core/services/logistics/؛ ربط المدن والمخازن والطرق، تكاليف/سعة/حجز/وصول، إلغاء/إعادة توجيه وفق قرار معتمد | FR-02/06/07؛ لا شحنة في رصيد مدينتين، لا وصول مبكر، إغلاق يمنع الجديدة ويعالج القائمة صراحة؛ `tests/unit/logistics.test.ts` و`tests/integration/trade.test.ts`؛ SC-03/04/17. |
| T08 / تكامل S0 / T06/T07 | apps/cli/src/{main.ts,controllers/run.ts,config/wiring.ts} وpackages/scenarios/src/initial-two-cities.ts؛ تقارير إنتاج/مخزون/سعر وأسبابها | FR-01/12، §19: **مدينتان + حبوب/خشب/أدوات + منتجون وسكان ومخزون وطريق + 100 Tick**، تقرير وتجارة فعلية وتكرار؛ `tests/integration/s0.test.ts` وsmoke CLI. لا يغلق VS ولا يفترض عدد دول لم يحدده §19. |
| T09 / حكومة/وكلاء مبسطون / T08 + Q03/Q06 | core/services/{agents,government,diplomacy}/؛ حكومتان، تدخل ضريبة أو دعم، قرار تجاري مستقل، قرار مسجل البدائل/القيود/السبب | FR-08/10/11؛ تنفيذ التدخل بمال فعلي وموعد، قرار تجاري قبول/رفض دون إجبار دولة؛ `tests/unit/{agents,government,diplomacy}.test.ts` و`tests/integration/policies.test.ts`. |
| T10 / تكامل VS / T09 | packages/scenarios/src/vertical-slice.ts وtests/integration/vs.test.ts؛ توسيع CLI والتقارير | FR-01–08/10–12 بالمستوى المبسط لا كامل M1: **دولتان، 2–4 مدن، 5 سلع، مجموعتان سكانيتان على الأقل، حكومة لكل دولة، طريق بكلفة ومدة، تدخل اقتصادي وقرار دبلوماسي، 1000 Tick** متكررة. خمس سلع وتوزيع السكان يحتاجان اعتماد بيانات. لا واجهة ولا كل السياسة المعقدة؛ A–C متكاملة، D الكامل باقٍ. |

## 4. تعميق M1 — US2/US3، أولوية P2

كل توازٍ أدناه بعد اعتماد توسعة العقود المشتركة بواسطة المنسق، لا أن يغير كل عامل WorldState منفردًا.

| ID / المالك / يعتمد على | النطاق والمخرجات المستهدفة | القبول والاختبارات المخططة |
|---|---|---|
| T11 [P] / سكان ومدن / T10 + Q05 | core/services/{population,cities}/؛ هجرة/مهارات وفئات وحاجات وخدمات، مواليد/وفيات إن فُعّلت، نمو غير ثابت | FR-04/07؛ خصم/إضافة السكان متسقان، كلفة انتقال وفرص عمل واستقرار، عزل/صفر سكان بلا انهيار؛ `tests/unit/cities.test.ts` وتوسعة population.test.ts؛ SC-12/17 وINV-04. |
| T12 [P] / منشآت / T10 + Q04 | core/services/{firms,production}/؛ توسع/استثمار/إغلاق/تصفية منتج والتزاماته ومخزونه ومعداته، أثر العمل | FR-03/07/11؛ الملكية لا تضيع عند الإفلاس، الاستثمار ممول وسعته تتغير عند السريان، البطالة تنتقل عبر علاقات فعلية؛ `tests/integration/lifecycle.test.ts`؛ SC-08/13. لا بنوك/ديون M2+ ضمنًا. |
| T13 [P] / حكومة / T10 + Q06/Q08 | core/services/government/؛ ضرائب/دعم/جمارك/استثمار/قيود، تأخير وتنفيذ، أربعة أشكال حكم بقواعد مؤسسية فعلية | FR-07/08/11؛ خزينة مصدر/وجهة وتكلفة/مدة، عجز يعالج بإجراء معرف لا خلق مال، انتقال سياسي مبسط وفق Q08؛ `tests/unit/government.test.ts`؛ SC-07/08/11/14/17. |
| T14 [P] / دبلوماسية ونقل / T10 + Q09 وADR-07 | core/services/diplomacy/ وتوسعة logistics؛ ثقة/مصالح واتفاقات رسوم/حصص/مدة/انسحاب/جزاء وعقوبات | FR-06/10/11؛ السلع والأطراف المشمولة فقط، رفض مستقل والرد المضاد ليس إلزاميًا، الشحنات القائمة معلومة المصير؛ diplomacy.test.ts وtrade.test.ts؛ SC-09/10/04. هذا العامل وحده يملك توسعة logistics في هذه الدفعة. |
| T15 / سياسة اجتماعية / T11–T13 + Q08 | core/services/politics/؛ جماعات/مطالب/تنظيم واحتجاج وإضراب وتفاوض، تأثير عبر خطط أثر لا تعديل خدمات أخرى | FR-09/11؛ حالات proposed/active/negotiating/resolved/failed/expired بانتقالات وأسباب، أثر القدرة والأجور والضرائب، ضغط سعر بلا تنظيم لا يفرض إضرابًا؛ `tests/unit/politics.test.ts` وSC-05/06 بضوابط رفض/فشل/انتهاء. |
| T16 / تكامل M1 core / T11–T15 | packages/scenarios/src/three-nations-trade-and-politics.ts وpackages/analytics/src/{projections,queries}.ts؛ كل الأنظمة مترابطة وCLI كامل | FR-01–12؛ **3 دول/12 مدينة/15 سلعة/6 قطاعات/5 فئات/4 حكومات مدعومة** (لا يلزم ظهور أربعة أشكال في ثلاث دول معًا)؛ Config قابل للتغيير، صدمة قابلة للضبط بعد 120؛ `tests/integration/m1.test.ts` و`tests/unit/analytics.test.ts` ومجموعة السيناريوهات؛ Gate D متعدد العوامل لا قصة. |

## 5. حفظ وتحليل وتقديم ومراجعة — US4/US5، أولوية P2/P3

| ID / المالك / يعتمد على | النطاق والمخرجات المستهدفة | القبول والاختبارات المخططة |
|---|---|---|
| T17 [P مع تعميق M1 بعد تثبيت codec] / حفظ / T10 وT04 | core/ports/{snapshot-store,run-store}.ts وpackages/persistence/src/{repositories,schema,migrations}/؛ PostgreSQL/Drizzle وسجل التجارب/أوامر وsnapshot | FR-01/12؛ حفظ ذري وتحقق حجم/نسخة، فساد/فشل كتابة لا ينشر حفظًا ناقصًا؛ restore/continue مطابق للمتصل، عزل تشغيلين؛ restore.test.ts و`tests/integration/persistence.test.ts`. الاختبار الفعلي بقاعدة مؤقتة بعد إذن خدمات؛ fake ليس إثبات PostgreSQL. |
| T18 / API وأمن / T16/T17 | apps/api/src/{controllers,services,transport,middleware,config}/ وpackages/contracts/src/؛ عمليات §10.2، تحقق/صلاحيات/audit/idempotency وترتيب أوامر وتشغيل طويل | FR-01/08/12؛ إصدار API وأخطاء مجال، رفض غير مخول/حجم مفرط، retries لا تكرر الأثر، تعارض أوامر بترتيب معلوم؛ `tests/api/{worlds,commands,runs}.test.ts`. عقد المخول/المصادقة يعتمد قبل التنفيذ؛ WebSocket فقط عند حاجة مثبتة. |
| T19 / مقارنة / T16/T17 | packages/analytics/src/compare.ts وربط snapshots/metrics؛ تفرع تشغيلين معزولين وbaseline محدد النسخة | FR-12؛ SC-16: Snapshot عند **200**، A دعم زائد/B بلا زيادة ثم **100** Tick؛ مقارنة أسعار/ميزانية/رضا/آثار جانبية، الأصل لا يتغير؛ `tests/integration/counterfactual.test.ts`؛ يغلق E مع T17. |
| T20 / واجهة / T18/T19 | apps/web/src/{ui,state,api,transport,shared}/؛ React/Vite، خريطة PixiJS، مؤشرات ECharts، أوامر/أحداث/مقارنة | FR-01/12؛ تعرض المدن والطرق والمقاييس والأسباب، فلاتر وفترات وترقيم أحداث، أخطاء وصلاحيات التشغيل؛ `tests/contract/web-api.test.ts`؛ لا قواعد اقتصاد في UI، mocks تحقق العرض لا التكامل الحقيقي. |
| T21 / QA رحلات / T20 | tests/e2e/world.spec.ts وtests/e2e/compare.spec.ts؛ Playwright على API والنواة الحقيقيين ببيانات خيالية | إنشاء/تشغيل/أمر حكومي/رصد خريطة ومقاييس وأحداث وحفظ/تفرع مقارنة؛ تحقق رفض غير مخول وعدم تكرار الأمر وأخطاء الاتصال. اختبار API فقط لا يغلق F؛ المتصفح الفعلي مطلوب. |
| T22 / مراجع تكامل وأداء / T16–T21 | tests/{regression,performance}/، docs/{setup,benchmarks}.md وتحديث أدلة القبول/ADRs بإذن تعديلها | DoD-01–12 كاملًا، INV-01–10، SC-01–17 ودفتر التأجيل المعتمد؛ CI lint/typecheck/test/build وAPI/E2E؛ قياس 3/12/100 مدينة بحسب fixtures و3 دول/12 مدينة/1000 Tick دون انهيار/تسرب وفق بروتوكول Q10. نشر الجهاز/الإصدارات/الذاكرة/زمن المراحل وأوامر التشغيل؛ لا سقف مختلق ولا تحسين threads قبل القياس. |
| T23 / باحث / اختيار صريح مستقل بعد الدليل المناسب، ليس شرط T22 | مذكرة بحث في docs/research/ لموضوع M2+ مختار: R&D، نقد/بنوك/ديون/أزمات، انتخابات مفصلة/أحزاب، نزاع استراتيجي، اتفاقات متعددة الأطراف/قوانين متقدمة، مدن أكثر/threads؛ Rust/WASM إن برره قياس | تجربة محدودة ومعيار نجاح يحددان قبل التنفيذ؛ مقارنة baseline وحتمية وكلفة، وقرار اعتماد/رفض جديد. لا إدخالها في DoD M1 ولا تشغيل تلقائي. |

## 6. خريطة FR → قبول → مهمة → اختبار

AC يحيل إلى النص الكامل في [مواصفة المنتج](product-spec.md#4-المتطلبات-الوظيفية-الكاملة-والتتبع)، وSC إلى [المصفوفة](scenarios.md). لا تعني تغطية VS اكتمال المتطلب بمستوى M1.

| المتطلب / القبول | المهام المسؤولة | أدلة الاختبار الرئيسية |
|---|---|---|
| FR-01 / AC-01 | T03/T04/T08/T10/T17/T18 | core، determinism، restore؛ SC-15/16/17 |
| FR-02 / AC-02 | T05/T06/T07/T22 | accounting + invariants؛ SC-03/17 |
| FR-03 / AC-03 | T06/T12/T15 | production + lifecycle؛ SC-01/02/05/13 |
| FR-04 / AC-04 | T06/T11/T16 | population + invariants؛ SC-02/07/12 |
| FR-05 / AC-05 | T01/T06/T10/T16 | market؛ SC-01/02/07–10/17 |
| FR-06 / AC-06 | T07/T09/T14 | logistics + trade؛ SC-03/04/09/10/17 |
| FR-07 / AC-07 | T07/T11/T12/T13 | cities + lifecycle؛ SC-04/08/12/17 |
| FR-08 / AC-08 | T09/T13/T16 | government + accounting؛ SC-07/08/11/14/17 |
| FR-09 / AC-09 | T15/T16 | politics؛ SC-05/06/11 وضابط عدم الإضراب |
| FR-10 / AC-10 | T09/T14/T16 | diplomacy + trade؛ SC-09/10 |
| FR-11 / AC-11 | T09/T12–T15 | agents + determinism؛ سجل خيارات/قيود كل قرار |
| FR-12 / AC-12 | T08/T16–T21 | analytics/counterfactual/API/E2E؛ SC-01/15/16 |

## 7. ترتيب الدمج وإغلاق المشروع

`T00 → T01 → T02 → (T03 → T04 || T05) → (T06 || T07) → T08 → T09 → T10` ثم `(T11 || T12 || T13 || T14 || T17)`، و`T11/T12/T13 → T15 → T16`، ثم `T16/T17 → (T18 || T19) → T20 → T21 → T22`. الرمز `||` مشروط باختلاف الملفات والعقود؛ ترتيب dependencies في الصفوف هو الحاكم.

S0 = 2/3/100 فقط؛ VS = 2 دولة/2–4 مدن/5 سلع/1000 والتدخلان؛ M1 = الأهداف الكاملة وDoD في product-spec.md §6. Gate A/B/C يعاد إثباتها على الشرائح الأكبر، D عند T15/T16، E عند T17/T19، F عند T21. لا يُغلق أي منها الآن. استثناء السيناريو المؤجل من DoD-06 محفوظ لكنه يحتاج سجلًا وموافقة، لا حذف مهمة. حزم أول إرسال وملكية الدمج في [delegation.md](delegation.md).
