HTML_TEMPLATE = """
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>OpenHW | Health Report</title>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@300;400;600;700&display=swap" rel="stylesheet">
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <style>
        :root {{
            --bg-color: #0d1117;
            --sidebar-bg: #161b22;
            --card-bg: #21262d;
            --accent-green: #2eb67d;
            --accent-blue: #38bdf8;
            --accent-red: #f85149;
            --text-main: #c9d1d9;
            --text-bright: #ffffff;
            --border: #30363d;
        }}
        * {{ margin: 0; padding: 0; box-sizing: border-box; }}
        body {{ font-family: 'Inter', sans-serif; background-color: var(--bg-color); color: var(--text-main); overflow: hidden; height: 100vh; }}
        nav {{ height: 60px; background: var(--sidebar-bg); border-bottom: 1px solid var(--border); display: flex; align-items: center; padding: 0 20px; justify-content: space-between; z-index: 100; }}
        .nav-left {{ display: flex; align-items: center; gap: 15px; }}
        .collapse-btn {{ background: transparent; border: none; color: var(--text-main); cursor: pointer; font-size: 1.2rem; }}
        .nav-brand {{ font-weight: 700; color: var(--text-bright); font-size: 1.1rem; }}
        .nav-tabs {{ display: flex; gap: 10px; }}
        .nav-btn {{ padding: 8px 16px; border-radius: 8px; border: 1px solid var(--border); background: transparent; color: var(--text-main); cursor: pointer; }}
        .nav-btn.active {{ background: var(--accent-green); color: white; border-color: var(--accent-green); }}
        .layout {{ display: flex; height: calc(100vh - 60px); }}
        .sidebar {{ width: 320px; background: var(--sidebar-bg); border-right: 1px solid var(--border); overflow-y: auto; padding: 15px; transition: 0.3s; flex-shrink: 0; }}
        .sidebar.collapsed {{ width: 0; padding: 0; overflow: hidden; border-right: none; }}
        .service-item {{ padding: 12px; border-radius: 8px; margin-bottom: 8px; cursor: pointer; border: 1px solid transparent; }}
        .service-item:hover {{ background: var(--card-bg); }}
        .service-item.active {{ background: #23863622; border-color: var(--accent-green); }}
        .service-header {{ display: flex; justify-content: space-between; align-items: center; }}
        .service-name {{ font-weight: 600; color: var(--text-bright); font-size: 0.95rem; }}
        .service-status {{ font-size: 0.75rem; font-weight: 700; color: var(--accent-green); }}
        .uptime-mini-bar {{ display: flex; gap: 2px; margin-top: 8px; }}
        .pill {{ width: 4px; height: 16px; border-radius: 2px; background: var(--accent-green); opacity: 0.3; }}
        .pill.active {{ opacity: 1; }}
        .pill.down {{ background: var(--accent-red); opacity: 1; }}
        .main-content {{ flex: 1; padding: 25px; overflow-y: auto; background: var(--bg-color); }}
        .tab-view {{ display: none; }}
        .tab-view.active {{ display: block; }}
        .metrics-grid {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap: 20px; margin-bottom: 30px; }}
        .card {{ background: var(--card-bg); border-radius: 12px; padding: 20px; border: 1px solid var(--border); }}
        .card-title {{ color: var(--text-main); opacity: 0.6; font-size: 0.8rem; text-transform: uppercase; margin-bottom: 10px; }}
        .card-value {{ font-size: 1.5rem; font-weight: 700; color: var(--text-bright); }}
        .status-hero {{ display: flex; justify-content: space-between; align-items: center; background: var(--card-bg); padding: 30px; border-radius: 12px; margin-bottom: 20px; border: 1px solid var(--border); }}
        .uptime-main-bar {{ background: rgba(46, 182, 125, 0.05); height: 60px; border-radius: 12px; display: flex; align-items: center; padding: 0 10px; gap: 4px; flex: 1; margin: 0 30px; overflow: hidden; }}
        .main-pill {{ flex: 1; height: 35px; border-radius: 6px; background: var(--accent-green); min-width: 5px; }}
        .main-pill.down {{ background: var(--accent-red); box-shadow: 0 0 10px var(--accent-red); }}
        .big-badge {{ min-width: 80px; height: 80px; border-radius: 50%; background: var(--accent-green); color: white; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 1.5rem; }}
        .chart-box {{ background: var(--card-bg); padding: 25px; border-radius: 12px; border: 1px solid var(--border); margin-bottom: 20px; }}
        .chart-header {{ display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }}
        .time-tags {{ display: flex; gap: 10px; }}
        .tag {{ padding: 4px 12px; border-radius: 6px; background: rgba(255, 255, 255, 0.05); font-size: 0.8rem; cursor: pointer; border: 1px solid var(--border); }}
        .tag.active {{ background: var(--accent-blue); color: white; border-color: var(--accent-blue); }}
        .chart-container {{ height: 320px; }}
        .log-section {{ margin-top: 20px; }}
        .log-header {{ background: var(--sidebar-bg); padding: 12px 20px; border-radius: 8px; display: flex; justify-content: space-between; cursor: pointer; border: 1px solid var(--border); }}
        .log-content {{ background: #000; color: #2eb67d; font-family: 'Courier New', Courier, monospace; padding: 20px; border-radius: 0 0 8px 8px; font-size: 0.9rem; max-height: 0; overflow: hidden; transition: 0.3s; border: 1px solid var(--border); border-top: none; }}
        .log-content.expanded {{ max-height: 500px; overflow-y: auto; }}
        .infra-sidebar {{ width: 300px; display: flex; flex-direction: column; gap: 15px; }}
        .infra-card {{ background: var(--card-bg); padding: 15px; border-radius: 10px; border: 1px solid var(--border); }}
    </style>
</head>
<body>
    <nav>
        <div class="nav-left">
            <button class="collapse-btn" onclick="toggleSidebar()">☰</button>
            <div class="nav-brand">OpenHW Monitor</div>
        </div>
        <div class="nav-tabs">
            <button class="nav-btn active" id="btn-dashboard" onclick="showTab('dashboard')">Dashboard</button>
            <button class="nav-btn" id="btn-system" onclick="showTab('system')">System View</button>
        </div>
    </nav>
    <div class="layout">
        <div class="sidebar" id="sidebar">{sidebar_items}</div>
        <div class="main-content">
            <div id="view-dashboard" class="tab-view active">
                <h1 style="margin-bottom: 25px;">Global Infrastructure</h1>
                <div class="metrics-grid">
                    <div class="card"><div class="card-title">VM CPU Load</div><div class="card-value">{host_cpu}</div></div>
                    <div class="card"><div class="card-title">VM RAM Usage</div><div class="card-value">{host_ram}</div></div>
                    <div class="card"><div class="card-title">Storage Status</div><div class="card-value">{host_disk}</div></div>
                    <div class="card"><div class="card-title">Node Uptime</div><div class="card-value">{host_uptime}</div></div>
                </div>
                <h3 style="margin-bottom: 15px;">Live Containers</h3>
                <div style="display: grid; grid-template-columns: repeat(2, 1fr); gap: 15px;">{container_cards}</div>
            </div>
            <div id="view-system" class="tab-view">
                <div class="status-hero">
                    <div style="flex: 1;">
                        <h2 id="sys-title">Select Service</h2>
                        <p id="sys-url" style="color: var(--accent-blue); font-size: 0.9rem; margin-top: 5px;">-</p>
                    </div>
                    <div class="uptime-main-bar" id="sys-main-bar"></div>
                    <div class="big-badge" id="sys-status-badge">Up</div>
                </div>
                <div class="metrics-grid">
                    <div class="card"><div class="card-title">Container Load</div><div class="card-value" id="sys-load">-</div></div>
                    <div class="card"><div class="card-title">Container RAM</div><div class="card-value" id="sys-mem">-</div></div>
                    <div class="card"><div class="card-title">Image ID</div><div class="card-value" id="sys-image-id" style="font-size: 0.85rem; font-family: monospace;">-</div></div>
                    <div class="card"><div class="card-title">Version Tag</div><div class="card-value" id="sys-version" style="font-size: 0.9rem;">-</div></div>
                </div>
                <div style="display: flex; gap: 20px;">
                    <div class="chart-box" style="flex: 1;">
                        <div class="chart-header">
                            <h3 style="font-size: 1rem;">CPU Load History (%)</h3>
                            <div class="time-tags">
                                <span class="tag active" onclick="setRange('24h', this)">24h</span>
                                <span class="tag" onclick="setRange('7d', this)">7d</span>
                                <span class="tag" onclick="setRange('30d', this)">30d</span>
                            </div>
                        </div>
                        <div class="chart-container"><canvas id="sysChart"></canvas></div>
                    </div>
                    <div class="infra-sidebar">
                        <div class="infra-card"><b>VM Load Avg:</b><br>{load_avg}</div>
                        <div class="infra-card"><b>Network VM:</b><br>{network_io}</div>
                        <div class="infra-card"><b>Disk Space:</b><br>{host_disk_detailed}</div>
                    </div>
                </div>
                <div class="log-section">
                    <div class="log-header" onclick="toggleLogs()">
                        <span>📜 Container Logs</span>
                        <span id="log-arrow">▼</span>
                    </div>
                    <pre class="log-content" id="log-content">Select a container to view logs...</pre>
                </div>
            </div>
        </div>
    </div>
    <script>
        let myChart = null;
        const serviceData = {service_data_js};
        function toggleSidebar() {{ document.getElementById('sidebar').classList.toggle('collapsed'); }}
        function showTab(tabName) {{
            document.querySelectorAll('.tab-view').forEach(v => v.classList.remove('active'));
            document.getElementById('view-' + tabName).classList.add('active');
            document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
            document.getElementById('btn-' + tabName).classList.add('active');
            if(tabName === 'system') {{
                const active = document.querySelector('.service-item.active');
                if (active) {{
                    const name = active.getAttribute('data-name');
                    updateSystemView(name);
                }}
            }}
        }}
        function switchService(name, element) {{
            document.querySelectorAll('.service-item').forEach(i => i.classList.remove('active'));
            element.classList.add('active');
            showTab('system');
            updateSystemView(name);
        }}
        function updateSystemView(name) {{
            const data = serviceData[name];
            document.getElementById('sys-title').innerText = name;
            document.getElementById('sys-url').innerText = data.url;
            document.getElementById('sys-load').innerText = data.load;
            document.getElementById('sys-mem').innerText = data.mem;
            document.getElementById('sys-image-id').innerText = data.image_id;
            document.getElementById('sys-version').innerText = data.version;
            document.getElementById('sys-uptime-pct').innerText = data.uptime_pct + '%';
            document.getElementById('log-content').innerText = data.logs;
            document.getElementById('sys-status-badge').innerText = data.status_text;
            renderMainBar(data.status_pills);
            setRange('24h', document.querySelector('.tag.active'));
        }}
        function setRange(range, element) {{
            document.querySelectorAll('.time-tags .tag').forEach(t => t.classList.remove('active'));
            element.classList.add('active');
            const active = document.querySelector('.service-item.active').getAttribute('data-name');
            const data = serviceData[active].history[range];
            let labels = [];
            if(range === '24h') labels = data.labels;
            else if(range === '7d') labels = data.labels;
            else labels = data.labels;
            initChart(data.values, serviceData[active].status_pills, labels);
        }}
        function toggleLogs() {{
            const content = document.getElementById('log-content');
            content.classList.toggle('expanded');
            document.getElementById('log-arrow').innerText = content.classList.contains('expanded') ? '▲' : '▼';
        }}
        function renderMainBar(status) {{
            const bar = document.getElementById('sys-main-bar');
            bar.innerHTML = '';
            status.forEach(s => {{
                const p = document.createElement('div');
                p.className = 'main-pill' + (s === 0 ? ' down' : '');
                bar.appendChild(p);
            }});
        }}
        function initChart(history, status, labels) {{
            const ctx = document.getElementById('sysChart').getContext('2d');
            if(myChart) myChart.destroy();
            myChart = new Chart(ctx, {{
                type: 'line',
                data: {{
                    labels: labels,
                    datasets: [{{
                        data: history, borderColor: '#2eb67d', fill: true, tension: 0.4, borderWidth: 2, pointRadius: 0,
                        backgroundColor: 'rgba(46, 182, 125, 0.1)'
                    }}]
                }},
                options: {{
                    responsive: true, maintainAspectRatio: false,
                    plugins: {{ legend: {{ display: false }} }},
                    scales: {{ y: {{ grid: {{ color: '#30363d' }}, ticks: {{ color: '#8b949e', callback: v => v + '%' }}, beginAtZero: true }}, x: {{ ticks: {{ color: '#8b949e', maxRotation: 0 }} }} }}
                }},
                plugins: [{{
                    id: 'downtimeHighlight',
                    beforeDraw: (c) => {{
                        const {{ctx, chartArea, scales: {{x}}}} = c;
                        // Use actual status history length to map highlights
                        const step = chartArea.width / (history.length - 1);
                        status.slice(-history.length).forEach((s, i) => {{
                            if (s === 0) {{
                                const xPos = x.getPixelForValue(i);
                                ctx.fillStyle = 'rgba(248, 81, 73, 0.25)';
                                ctx.fillRect(xPos - 5, chartArea.top, 10, chartArea.height);
                            }}
                        }});
                    }}
                }}]
            }});
        }}
        // Initial setup
        window.onload = () => {{
            const first = document.querySelector('.service-item');
            if (first) switchService(first.getAttribute('data-name'), first);
        }};
    </script>
</body>
</html>
"""
