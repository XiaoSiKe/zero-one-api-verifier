(() => {
  'use strict';

  const csrfToken = document.querySelector('meta[name="csrf-token"]')?.content || '';
  const liveRegion = document.querySelector('#live-status');

  function announce(message) {
    if (!liveRegion) return;
    liveRegion.textContent = '';
    window.setTimeout(() => { liveRegion.textContent = message; }, 10);
  }

  function pick(object, names, fallback = '') {
    for (const name of names) {
      if (object && object[name] !== undefined && object[name] !== null) return object[name];
    }
    return fallback;
  }

  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    headers.set('Accept', 'application/json');
    if (options.body && !headers.has('Content-Type')) headers.set('Content-Type', 'application/json');
    if (csrfToken) headers.set('X-CSRF-Token', csrfToken);

    const response = await fetch(url, { ...options, headers, credentials: 'same-origin' });
    const contentType = response.headers.get('content-type') || '';
    const payload = contentType.includes('application/json')
      ? await response.json()
      : { message: await response.text() };

    if (!response.ok) {
      const error = new Error(pick(payload, ['message', 'error_description', 'error'], '请求失败，请稍后重试。'));
      error.code = pick(payload, ['code', 'error_code', 'error'], 'request_failed');
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  async function copyText(text) {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return;
    }
    const helper = document.createElement('textarea');
    helper.value = text;
    helper.setAttribute('readonly', '');
    helper.style.position = 'fixed';
    helper.style.opacity = '0';
    document.body.append(helper);
    helper.select();
    const copied = document.execCommand('copy');
    helper.remove();
    if (!copied) throw new Error('copy_failed');
  }

  document.addEventListener('click', async (event) => {
    const button = event.target.closest('[data-copy-target]');
    if (!button) return;
    const target = document.getElementById(button.dataset.copyTarget);
    const value = target?.value ?? target?.textContent ?? '';
    if (!value) {
      announce('当前没有可复制的内容。');
      return;
    }

    const previous = button.textContent;
    try {
      await copyText(value);
      button.textContent = '已复制';
      announce('已复制到剪贴板。');
    } catch {
      button.textContent = '请手动复制';
      announce('自动复制失败，请手动选择并复制。');
      target.focus();
      target.select?.();
    }
    window.setTimeout(() => { button.textContent = previous; }, 1600);
  });

  function normalizeIntegration(payload) {
    const root = payload?.integration || payload?.data || payload || {};
    const config = root.config || payload?.config || {};
    return {
      id: pick(root, ['id', 'integration_id', 'integrationId', 'merchant_id', 'merchantId']),
      siteUrl: pick(root, ['site_url', 'siteUrl', 'merchant_url', 'merchantUrl', 'origin']),
      type: String(pick(root, ['type', 'provider_type', 'providerType', 'template', 'mode'], 'oidc')).toLowerCase(),
      status: String(pick(root, ['status', 'state'], 'pending')).toLowerCase(),
      issuer: pick(config, ['issuer'], pick(root, ['issuer'])),
      discoveryUrl: pick(config, ['discovery_url', 'discoveryUrl', 'well_known'], pick(root, ['discovery_url', 'discoveryUrl', 'well_known'])),
      clientId: pick(config, ['client_id', 'clientId'], pick(root, ['client_id', 'clientId'])),
      clientSecret: pick(config, ['client_secret', 'clientSecret'], pick(root, ['client_secret', 'clientSecret', 'secret'])),
      redirectUri: pick(config, ['redirect_uri', 'redirectUri', 'callback_url', 'callbackUrl'], pick(root, ['redirect_uri', 'redirectUri', 'callback_url', 'callbackUrl'])),
      scopes: pick(config, ['scope', 'scopes'], pick(root, ['scope', 'scopes'], 'openid profile email')),
      startUrl: pick(root, ['start_url', 'startUrl', 'login_url', 'loginUrl', 'test_url', 'testUrl']),
      copyConfig: pick(root, ['copy_config', 'copyConfig', 'configuration_text', 'configurationText']),
      message: pick(root, ['message', 'failure_reason', 'failureReason']),
      requiresType: Boolean(pick(root, ['requires_type', 'requiresType', 'manual_type_required'], false)),
    };
  }

  const connectApp = document.querySelector('[data-connect-app]');
  if (connectApp) setupConnect(connectApp);

  function setupConnect(app) {
    const isDemo = app.dataset.demo === '1';
    const form = app.querySelector('#connect-form');
    const siteInput = app.querySelector('#site-url');
    const typePicker = app.querySelector('#type-picker');
    const submitButton = app.querySelector('#connect-submit');
    const checkButton = app.querySelector('#check-button');
    const rotateSecret = app.querySelector('#rotate-secret');
    const testLogin = app.querySelector('#test-login');
    const enterMerchant = app.querySelector('#enter-merchant');
    const errorBox = app.querySelector('#connect-error');
    const errorMessage = app.querySelector('#connect-error-message');
    const stages = [...app.querySelectorAll('.stage')];
    let integration = null;

    const copy = {
      input: ['自动配置', '连接你的站点', '填写站点地址，剩下的我们来完成。'],
      working: ['正在处理', '正在自动接入', '正在识别站点并生成安全配置。'],
      config: ['只需保存一次', '保存商家配置', '复制到商家后台，保存后我们会自动检查。'],
      ready: ['最后验证', '测试一键登录', '检查已经通过，完成一次登录即可启用。'],
      done: ['接入完成', 'SSO 已可使用', '用户现在可以一键进入商家。'],
    };

    function setHeading(state) {
      const values = copy[state];
      app.querySelector('#step-label').textContent = values[0];
      app.querySelector('#page-title').textContent = values[1];
      app.querySelector('#page-description').textContent = values[2];
    }

    function showStage(name, focus = true) {
      stages.forEach((stage) => { stage.hidden = stage.id !== `stage-${name}`; });
      errorBox.hidden = true;
      setHeading(name);
      if (focus) {
        const target = app.querySelector(`#stage-${name} :is(input, button, a, summary)`);
        target?.focus({ preventScroll: true });
      }
    }

    function showError(message, allowTypeChoice = false) {
      if (allowTypeChoice) {
        showStage('input', false);
        typePicker.hidden = false;
        typePicker.querySelectorAll('input').forEach((input) => { input.required = true; });
        submitButton.textContent = '按所选类型接入';
        typePicker.querySelector('input')?.focus();
      }
      errorMessage.textContent = message;
      errorBox.hidden = false;
      announce(message);
      errorBox.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }

    function isReady(status) {
      return ['active', 'enabled', 'verified', 'ready', 'ready_for_test'].includes(status);
    }

    function isDone(status) {
      return ['connected', 'complete', 'completed'].includes(status);
    }

    function rememberId(id) {
      if (!id) return;
      try { sessionStorage.setItem('zeroone.integrationId', id); } catch { /* storage may be disabled */ }
    }

    function buildConfiguration(item) {
      const fields = [
        ['Issuer', item.issuer || app.dataset.issuer],
        ['Discovery URL', item.discoveryUrl],
        ['Client ID', item.clientId],
        ['Client Secret', item.clientSecret || '刷新后不再显示，请在平台轮换'],
        ['Redirect URI', item.redirectUri],
        ['Scopes', Array.isArray(item.scopes) ? item.scopes.join(' ') : item.scopes],
      ].filter(([, value]) => value);

      const configText = app.querySelector('#config-text');
      configText.value = item.copyConfig || fields.map(([name, value]) => `${name}: ${value}`).join('\n');

      const details = app.querySelector('#technical-fields');
      details.replaceChildren(...fields.map(([name, value]) => {
        const row = document.createElement('div');
        const term = document.createElement('dt');
        const description = document.createElement('dd');
        term.textContent = name;
        description.textContent = value;
        row.append(term, description);
        return row;
      }));

      app.querySelector('#secret-note').hidden = !item.clientSecret;
      app.querySelector('#compatibility-note').hidden = !['new-api', 'new_api', 'one-api', 'one_api'].includes(item.type);
      rotateSecret.hidden = item.type === 'handoff';
    }

    function openReady(item, autoStart = false) {
      integration = { ...integration, ...item };
      const startUrl = integration.startUrl || `/sso/merchants/${encodeURIComponent(integration.id)}/start`;
      testLogin.href = startUrl;
      enterMerchant.href = startUrl;
      showStage('ready');
      announce('已检测到 OIDC 配置，可以继续完成真实登录验证。');
      if (autoStart) window.location.assign(startUrl);
    }

    function openDone(item) {
      integration = { ...integration, ...item };
      const id = integration?.id || '';
      enterMerchant.href = integration?.startUrl || (id ? `/sso/merchants/${encodeURIComponent(id)}/start` : '/connect?demo=1');
      showStage('done');
      announce('SSO 已接入成功，可以一键登录。');
    }

    async function loadIntegration(id) {
      const payload = await request(`/api/integrations/${encodeURIComponent(id)}`);
      return normalizeIntegration(payload);
    }

    async function checkIntegration({ autoStart = false } = {}) {
      if (!integration?.id) throw new Error('缺少接入编号，请重新创建。');
      showStage('working', false);
      app.querySelector('#working-title').textContent = '正在检查配置';
      app.querySelector('#working-description').textContent = '保存成功后会自动继续。';
      announce('正在检查商家配置。');

      let current = normalizeIntegration(await request(
        `/api/integrations/${encodeURIComponent(integration.id)}/check`,
        { method: 'POST', body: '{}' },
      ));
      integration = { ...integration, ...current };

      for (let attempt = 0; attempt < 10 && !isReady(integration.status) && !isDone(integration.status); attempt += 1) {
        if (['failed', 'error', 'rejected'].includes(integration.status)) {
          throw new Error(integration.message || '检查失败，请确认配置已经保存。');
        }
        await new Promise((resolve) => window.setTimeout(resolve, 1200));
        current = await loadIntegration(integration.id);
        integration = { ...integration, ...current };
      }

      if (isDone(integration.status)) return openDone(integration);
      if (isReady(integration.status)) return openReady(integration, autoStart);
      buildConfiguration(integration);
      showStage('config');
      announce('尚未检测到商家配置，请确认保存后再次检查。');
    }

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      errorBox.hidden = true;
      if (!form.reportValidity()) return;

      const chosenType = new FormData(form).get('type') || (isDemo ? 'demo' : 'auto');
      showStage('working', false);
      submitButton.disabled = true;
      announce('正在自动识别并创建 SSO 接入。');

      try {
        const payload = await request('/api/integrations', {
          method: 'POST',
          body: JSON.stringify({
            siteUrl: siteInput.value.trim(),
            type: chosenType,
            demo: isDemo,
          }),
        });
        integration = normalizeIntegration(payload);
        rememberId(integration.id);

        if (integration.requiresType) {
          showError('请选择商家系统类型，我们会继续生成配置。', true);
        } else if (isDone(integration.status)) {
          openDone(integration);
        } else if (isReady(integration.status)) {
          openReady(integration, isDemo);
        } else if (isDemo) {
          await checkIntegration({ autoStart: true });
        } else {
          buildConfiguration(integration);
          showStage('config');
          announce('配置已生成，请复制到商家后台并保存。');
        }
      } catch (error) {
        const code = String(error.code || '').toLowerCase();
        const needsType = code.includes('detect') || code.includes('unknown_type') || code.includes('unsupported_type');
        if (!needsType) showStage('input', false);
        showError(error.message, needsType);
      } finally {
        submitButton.disabled = false;
      }
    });

    checkButton.addEventListener('click', async () => {
      checkButton.disabled = true;
      try {
        await checkIntegration();
      } catch (error) {
        buildConfiguration(integration || {});
        showStage('config', false);
        showError(error.message);
        checkButton.focus();
      } finally {
        checkButton.disabled = false;
      }
    });

    rotateSecret.addEventListener('click', async () => {
      if (!integration?.id) return showError('缺少接入编号，请重新创建。');
      rotateSecret.disabled = true;
      try {
        const payload = await request(
          `/api/integrations/${encodeURIComponent(integration.id)}/rotate-secret`,
          { method: 'POST', body: '{}' },
        );
        integration = { ...integration, ...normalizeIntegration(payload) };
        buildConfiguration(integration);
        announce('Client Secret 已重新生成，旧密钥立即失效。');
      } catch (error) {
        showError(error.message);
      } finally {
        rotateSecret.disabled = false;
      }
    });

    const query = new URLSearchParams(window.location.search);
    let storedId = '';
    try { storedId = sessionStorage.getItem('zeroone.integrationId') || ''; } catch { /* storage may be disabled */ }
    const restoreId = query.get('integration') || query.get('integration_id') || storedId;

    if (query.get('connected') === '1' || query.get('success') === '1' || query.get('status') === 'connected') {
      integration = { id: restoreId, startUrl: query.get('start_url') || '' };
      openDone(integration);
    } else if (query.get('integration') || query.get('integration_id')) {
      showStage('working', false);
      loadIntegration(restoreId)
        .then((item) => {
          integration = item;
          if (isDone(item.status)) openDone(item);
          else if (isReady(item.status)) openReady(item);
          else { buildConfiguration(item); showStage('config'); }
        })
        .catch((error) => { showStage('input', false); showError(error.message); });
    }
  }

  const invitesPage = document.querySelector('[data-invites-page]');
  if (invitesPage) setupInvites(invitesPage);

  async function setupInvites(page) {
    const clicks = page.querySelector('#invite-clicks');
    const registrations = page.querySelector('#invite-registrations');
    const conversion = page.querySelector('#invite-conversion');
    const inviteLink = page.querySelector('#invite-link');
    const rows = page.querySelector('#registration-rows');
    const empty = page.querySelector('#registration-empty');
    const error = page.querySelector('#invites-error');

    try {
      const [summaryPayload, registrationsPayload] = await Promise.all([
        request('/api/me/invites/summary'),
        request('/api/me/invites/registrations'),
      ]);
      const summary = summaryPayload.summary || summaryPayload.data || summaryPayload;
      const items = Array.isArray(registrationsPayload)
        ? registrationsPayload
        : (registrationsPayload.registrations || registrationsPayload.items || registrationsPayload.data || []);
      const clickCount = Number(pick(summary, ['uniqueClicks', 'unique_clicks', 'clicks', 'click_count', 'clickCount'], 0));
      const registrationCount = Number(pick(summary, ['successfulRegistrations', 'successful_registrations', 'registrations', 'registration_count', 'registrationCount'], 0));
      const rateValue = pick(summary, ['conversion_rate', 'conversionRate'], clickCount ? (registrationCount / clickCount) * 100 : 0);
      const numericRate = Number(String(rateValue).replace('%', ''));
      const resolvedRate = numericRate > 0 && numericRate <= 1 ? numericRate * 100 : numericRate;
      const code = pick(summary, ['invite_code', 'inviteCode']);
      const link = pick(summary, ['invite_link', 'inviteLink'], page.dataset.inviteLink || (code ? `${location.origin}/i/${code}` : ''));

      clicks.textContent = String(clickCount);
      registrations.textContent = String(registrationCount);
      conversion.textContent = `${Number.isFinite(resolvedRate) ? resolvedRate.toFixed(resolvedRate % 1 ? 1 : 0) : 0}%`;
      inviteLink.value = link;

      rows.replaceChildren(...items.map((item) => {
        const row = document.createElement('tr');
        const userCell = document.createElement('td');
        const dateCell = document.createElement('td');
        userCell.textContent = pick(item, ['masked_email', 'maskedEmail', 'email', 'user'], '已验证用户');
        const rawDate = pick(item, ['registered_at', 'registeredAt', 'bound_at', 'boundAt', 'created_at', 'createdAt']);
        const dateValue = typeof rawDate === 'number' && rawDate < 1e12 ? rawDate * 1000 : rawDate;
        const date = rawDate ? new Date(dateValue) : null;
        dateCell.textContent = date && !Number.isNaN(date.valueOf())
          ? new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(date)
          : String(rawDate || '');
        row.append(userCell, dateCell);
        return row;
      }));
      empty.hidden = items.length > 0;
      announce(`邀请统计已更新：${registrationCount} 人成功注册。`);
    } catch {
      error.hidden = false;
      announce('邀请统计加载失败。');
    }
  }
})();
