(() => {
  'use strict';

  const forms = [
    { title: '每月自評', prefix: 'selfEval', page: 'monthly_self_eval.html' },
    { title: '正向管教自我檢核', prefix: 'selfEvalPositive', page: 'positive_discipline.html' }
  ];
  const homes = { admin: 'admin.html', teacher: 'teacher.html', leader: 'leader.html' };
  const home = new URLSearchParams(location.search).get('home');
  const homePage = Object.hasOwn(homes, home) ? homes[home] : 'index.html';
  const back = document.getElementById('back');
  const refresh = document.getElementById('refresh');
  const login = document.getElementById('login');
  const container = document.getElementById('forms');
  const dateFormat = new Intl.DateTimeFormat('zh-TW', {
    timeZone: 'Asia/Taipei', dateStyle: 'short', timeStyle: 'short'
  });

  back.href = homePage;
  const cards = forms.map(form => {
    const card = document.createElement('article');
    const heading = document.createElement('h2');
    const status = document.createElement('p');
    const actions = document.createElement('div');
    const current = document.createElement('a');
    const history = document.createElement('a');
    heading.textContent = form.title;
    status.className = 'status';
    status.setAttribute('role', 'status');
    actions.className = 'actions';
    const params = new URLSearchParams({ from: 'form-center', home: home || '' });
    current.href = form.page + '?' + params;
    current.textContent = '開啟表單';
    params.set('view', 'history');
    history.href = form.page + '?' + params;
    history.textContent = '歷史紀錄';
    actions.append(current, history);
    card.append(heading, status, actions);
    container.append(card);
    return { form, status, current };
  });

  async function loadCard({ form, status, current }) {
    try {
      const boot = await HeremaySelfEval.call(form.prefix + 'Bootstrap');
      if (boot.role === 'admin') {
        current.textContent = '已交／未交名單';
        status.textContent = boot.month + '｜可查閱繳交名單';
        return;
      }

      current.textContent = '查看本期表單';
      if (!boot.opened) {
        status.textContent = boot.month + '｜尚未開放';
        return;
      }

      const id = String(boot.employee.employeeNo) + '_' + boot.month;
      const { record } = await HeremaySelfEval.call(form.prefix + 'Get', { id });
      const submittedAt = Number(record?.submittedAt);
      const date = submittedAt > 0 && Number.isFinite(submittedAt)
        ? '｜送出 ' + dateFormat.format(submittedAt) : '';
      status.textContent = boot.month + '｜' + (record?.status || '尚未送出') + date;
    } catch (error) {
      status.textContent = '讀取失敗｜' + error.message;
    }
  }

  async function load() {
    refresh.disabled = true;
    login.hidden = true;
    cards.forEach(({ status }) => { status.textContent = '正在讀取…'; });
    try {
      HeremaySelfEval.grant();
    } catch {
      login.hidden = false;
      cards.forEach(({ status }) => { status.textContent = '請重新登入後查看繳交狀態。'; });
      refresh.disabled = false;
      return;
    }
    await Promise.all(cards.map(loadCard));
    refresh.disabled = false;
  }

  refresh.addEventListener('click', load);
  document.getElementById('update').addEventListener('click', () => location.reload());
  addEventListener('pageshow', event => {
    if (event.persisted && !refresh.disabled) load();
  });
  load();
})();
