import docker
import requests
import time
import os
import datetime
import re
import json
from report_template import HTML_TEMPLATE

# Configuration
TELEGRAM_BOT_TOKEN = os.getenv("TELEGRAM_BOT_TOKEN")
TELEGRAM_CHAT_ID = os.getenv("TELEGRAM_CHAT_ID")
REPORT_INTERVAL = 3600  # 1 hour
WATCHDOG_INTERVAL = 300  # 5 minutes
HISTORY_FILE = "history.json"
RETENTION_DAYS = 40

# Patterns to mask (case-insensitive)
SCRUB_PATTERNS = [
    r'jwt[:=]\s*[^\s]+',
    r'secret[:=]\s*[^\s]+',
    r'password[:=]\s*[^\s]+',
    r'token[:=]\s*[^\s]+',
    r'key[:=]\s*[^\s]+',
    r'auth[:=]\s*[^\s]+',
    r'bearer\s+[^\s]+'
]

client = docker.from_env()

def scrub_logs(log_text):
    for pattern in SCRUB_PATTERNS:
        log_text = re.sub(pattern, lambda m: m.group(0).split(':')[0] + ": [MASKED]" if ':' in m.group(0) else "[MASKED]", log_text, flags=re.IGNORECASE)
    return log_text

def send_telegram_message(text):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendMessage"
    requests.post(url, json={"chat_id": TELEGRAM_CHAT_ID, "text": text, "parse_mode": "HTML"})

def send_telegram_document(filename, caption):
    url = f"https://api.telegram.org/bot{TELEGRAM_BOT_TOKEN}/sendDocument"
    with open(filename, "rb") as f:
        requests.post(url, data={"chat_id": TELEGRAM_CHAT_ID, "caption": caption}, files={"document": f})

def get_vm_stats():
    # RAM
    with open("/proc/meminfo", "r") as f:
        meminfo = f.readlines()
    total_mem = int(meminfo[0].split()[1]) / 1024 / 1024
    free_mem = int(meminfo[2].split()[1]) / 1024 / 1024
    used_mem = total_mem - free_mem
    
    # CPU Load
    with open("/proc/loadavg", "r") as f:
        load_avg = f.read().split()[:3]
    
    # Disk Usage
    path = "/host_root" if os.path.exists("/host_root") else "/"
    st = os.statvfs(path)
    free_disk = (st.f_bavail * st.f_frsize) / (1024**3)
    total_disk = (st.f_blocks * st.f_frsize) / (1024**3)
    
    # Uptime
    with open("/proc/uptime", "r") as f:
        uptime_seconds = float(f.read().split()[0])
    uptime_str = str(datetime.timedelta(seconds=int(uptime_seconds)))

    return {
        "cpu": f"{load_avg[0]}",
        "load_avg": ", ".join(load_avg),
        "total_mem": round(total_mem, 1),
        "used_mem": round(used_mem, 1),
        "mem_pct": round((used_mem / total_mem) * 100, 1),
        "total_disk": round(total_disk, 1),
        "free_disk": round(free_disk, 1),
        "uptime": uptime_str
    }

def load_history():
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "r") as f:
            return json.load(f)
    return {}

def save_history(history):
    # Rotate history: only keep last 40 days (40 * 24 * 12 checks)
    max_entries = RETENTION_DAYS * 24 * 12
    for service in history:
        history[service] = history[service][-max_entries:]
    with open(HISTORY_FILE, "w") as f:
        json.dump(history, f)

def collect_stats():
    history = load_history()
    now = datetime.datetime.now().strftime("%Y-%m-%d %H:%M")
    containers = client.containers.list(all=True)
    
    current_stats = {}
    for container in containers:
        name = container.name
        status = 1 if container.status == "running" else 0
        
        # Get real-time CPU/RAM usage
        cpu_pct = 0.0
        mem_usage = "0 MB"
        if status:
            try:
                stats = container.stats(stream=False)
                cpu_delta = stats["cpu_stats"]["cpu_usage"]["total_usage"] - stats["precpu_stats"]["cpu_usage"]["total_usage"]
                system_delta = stats["cpu_stats"]["system_cpu_usage"] - stats["precpu_stats"]["system_cpu_usage"]
                if system_delta > 0:
                    cpu_pct = (cpu_delta / system_delta) * len(stats["cpu_stats"]["cpu_usage"]["percpu_usage"]) * 100
                mem_usage = f"{round(stats['memory_stats']['usage'] / 1024 / 1024, 1)} MB"
            except: pass

        # Get Image info
        image_id = container.image.id.split(':')[-1][:12] # Short hash
        version = ", ".join(container.image.tags) if container.image.tags else "No Tag"

        if name not in history: history[name] = []
        history[name].append({"ts": now, "status": status, "load": round(cpu_pct, 1)})
        
        current_stats[name] = {
            "status": status,
            "load": f"{round(cpu_pct, 1)}%",
            "mem": mem_usage,
            "image_id": image_id,
            "version": version,
            "logs": scrub_logs(container.logs(tail=50).decode("utf-8", errors="ignore"))
        }

    save_history(history)
    return current_stats, history

def generate_html():
    current, history = collect_stats()
    vm = get_vm_stats()
    
    sidebar_html = ""
    container_cards = ""
    service_data_js = {}

    for name, stats in current.items():
        # Sidebar
        status_pct = round((sum(h['status'] for h in history[name][-100:]) / min(len(history[name]), 100)) * 100, 1)
        pills = "".join([f'<div class="pill active{" down" if h["status"]==0 else ""}"></div>' for h in history[name][-15:]])
        sidebar_html += f"""
        <div class="service-item" data-name="{name}" onclick="switchService('{name}', this)">
            <div class="service-header"><span class="service-name">{name}</span><span class="service-status">{status_pct}%</span></div>
            <div class="uptime-mini-bar">{pills}</div>
        </div>"""

        # Dashboard Card
        color = "var(--accent-green)" if stats['status'] else "var(--accent-red)"
        container_cards += f"""
        <div class="card" style="display:flex; justify-content:space-between">
            <span>{name}</span><span style="color:{color}">● { "Online" if stats['status'] else "Offline" }</span>
        </div>"""

        # JS Data
        h_24h = history[name][-288:] # 5 min intervals for 24h
        h_7d = history[name][-2016:]
        h_30d = history[name][-8640:]

        service_data_js[name] = {
            "url": "https://openhw-studio.fossee.in" if "backend" in name or "frontend" in name else "Internal Service",
            "load": stats['load'],
            "mem": stats['mem'],
            "image_id": stats['image_id'],
            "version": stats['version'],
            "avg": f"{round(sum(h['load'] for h in h_24h)/len(h_24h), 1)}%",
            "uptime_pct": status_pct,
            "status_text": "Up" if stats['status'] else "Down",
            "status_pills": [h['status'] for h in history[name][-30:]],
            "logs": stats['logs'],
            "history": {
                "24h": {"values": [h['load'] for h in h_24h[::6]], "labels": [h['ts'].split()[1] for h in h_24h[::6]]},
                "7d": {"values": [h['load'] for h in h_7d[::72]], "labels": [h['ts'].split()[0].split('-')[2] for h in h_7d[::72]]},
                "30d": {"values": [h['load'] for h in h_30d[::288]], "labels": [h['ts'].split()[0].split('-')[2] for h in h_30d[::288]]}
            }
        }

    # Generate Summary Caption
    summary_text = f"📊 <b>OpenHW Studio - Hourly Health Report</b> 📅 {datetime.datetime.now().strftime('%Y-%m-%d %H:%M')} UTC\n\n"
    summary_text += "🏗️ <b>Container Status</b>\n"
    for name, stats in current.items():
        icon = "✅" if stats['status'] else "🚨"
        summary_text += f"{icon} {name} - {'Running' if stats['status'] else 'Down'}\n"
    
    summary_text += f"\n📈 <b>Resource Analytics</b>\n"
    summary_text += f"CPU Load: {vm['cpu']}% (Avg)\n"
    summary_text += f"Memory: {vm['used_mem']}GB / {vm['total_mem']}GB ({vm['mem_pct']}%)\n"
    summary_text += f"Disk Space: {vm['free_disk']}GB Available\n"

    html = HTML_TEMPLATE.format(
        sidebar_items=sidebar_html,
        container_cards=container_cards,
        host_cpu=f"{vm['cpu']}%",
        host_ram=f"{vm['used_mem']} / {vm['total_mem']} GB",
        host_disk=f"{vm['free_disk']} GB Free",
        host_uptime=vm['uptime'].split(',')[0],
        load_avg=vm['load_avg'],
        network_io="Monitoring Active",
        host_disk_detailed=f"{vm['free_disk']} GB / {vm['total_disk']} GB",
        service_data_js=json.dumps(service_data_js)
    )

    filename = f"report_{datetime.datetime.now().strftime('%Y%m%d_%H%M')}.html"
    with open(filename, "w") as f:
        f.write(html)
    return filename, summary_text

def watchdog():
    print("🛡️ Health Agent Watchdog Started...")
    last_status = {}
    last_report_time = 0

    while True:
        try:
            current, history = collect_stats()
            
            # 1. Check for crashes
            for name, stats in current.items():
                if name in last_status and last_status[name] == 1 and stats['status'] == 0:
                    send_telegram_message(f"🚨 <b>CRITICAL: {name} has crashed!</b>\nTime: {datetime.datetime.now().strftime('%H:%M:%S')}")
                last_status[name] = stats['status']

            # 2. Hourly Report
            if time.time() - last_report_time >= REPORT_INTERVAL:
                print("📦 Generating Hourly Report...")
                report_file, summary = generate_html()
                send_telegram_document(report_file, summary)
                os.remove(report_file) # Clean up
                last_report_time = time.time()

        except Exception as e:
            print(f"❌ Error in watchdog: {e}")

        time.sleep(WATCHDOG_INTERVAL)

if __name__ == "__main__":
    watchdog()
