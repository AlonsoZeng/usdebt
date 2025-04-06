from flask import Flask, render_template, jsonify, request
import subprocess
import sqlite3
import pandas as pd
import plotly.express as px
from datetime import datetime, timedelta
import json
import re
import xml.etree.ElementTree as ET
import time
import io
import sys
import requests  # 添加 requests 模块的导入

app = Flask(__name__)

# 配置
DATABASE = 'mydatabase.db'
TABLE = 'mytable'

# 数据库操作函数
def get_db_connection():
    """创建数据库连接"""
    return sqlite3.connect(DATABASE)

def execute_query(query, params=None, fetch_all=True):
    """执行SQL查询并返回结果"""
    conn = get_db_connection()
    try:
        if params:
            result = pd.read_sql_query(query, conn, params=params)
        else:
            result = pd.read_sql_query(query, conn)
        return result
    finally:
        conn.close()

def execute_update(query, params=None):
    """执行SQL更新操作（插入、更新、删除）"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        if params:
            cursor.execute(query, params)
        else:
            cursor.execute(query)
        conn.commit()
        return cursor.rowcount  # 返回受影响的行数
    finally:
        conn.close()

def get_table_columns():
    """获取表的所有列名"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(f"PRAGMA table_info({TABLE})")
        return [row[1] for row in cursor.fetchall()]
    finally:
        conn.close()

def fetch_data(order_by='url', ascending=False, limit=None, offset=None):
    """从数据库获取数据"""
    query = f"SELECT * FROM {TABLE} ORDER BY {order_by} {'ASC' if ascending else 'DESC'}"
    if limit:
        query += f" LIMIT {limit}"
        if offset is not None:
            query += f" OFFSET {offset}"
    return execute_query(query)

def count_total_records():
    """获取数据库中的总记录数"""
    conn = get_db_connection()
    try:
        cursor = conn.cursor()
        cursor.execute(f"SELECT COUNT(*) FROM {TABLE}")
        return cursor.fetchone()[0]
    finally:
        conn.close()

# 日期处理函数
def get_default_dates():
    """获取默认日期范围"""
    today = datetime.now().date()
    last_monday = today - timedelta(days=today.weekday() + 7)
    last_friday = last_monday + timedelta(days=4)
    second_last_monday = last_monday - timedelta(days=7)
    second_last_friday = second_last_monday + timedelta(days=4)
    return last_monday, last_friday, second_last_monday, second_last_friday

# 路由
@app.route('/')
def index():
    """首页路由 - 支持分页"""
    # 获取分页参数
    page = request.args.get('page', 1, type=int)
    per_page = request.args.get('per_page', 20, type=int)  # 每页显示20条记录
    
    # 计算偏移量
    offset = (page - 1) * per_page
    
    # 获取分页数据
    data = fetch_data(limit=per_page, offset=offset)
    
    # 获取总记录数和计算总页数
    total_records = count_total_records()
    total_pages = (total_records + per_page - 1) // per_page  # 向上取整
    
    return render_template(
        'index.html', 
        tables=[data.to_html(classes='data', index=False)], 
        titles=data.columns.values,
        data=data,  # 添加原始数据传递给模板
        page=page,
        per_page=per_page,
        total_pages=total_pages,
        total_records=total_records
    )

@app.route('/update-data', methods=['POST'])
def update_data():
    """更新数据路由 - 集成 getNewXml.py 的功能"""
    try:
        # 捕获打印输出
        old_stdout = sys.stdout
        new_stdout = io.StringIO()
        sys.stdout = new_stdout
        
        # 配置参数
        config = {
            'database_path': DATABASE,
            'table_name': TABLE,
            'default_date': '1900-01-01',
            'date_columns': ['IssueDate', 'AuctionDate', 'MaturityDate'],
            'days_per_month': 30.41667
        }
        
        # 第一步：获取新的XML地址
        print("第1步：获取新的XML地址")
        
        # 定义起始年份和结束年份
        start_year = 2025
        end_year = 2025
        
        # 创建URL模板
        url_template = 'https://www.treasurydirect.gov/TA_WS/securities/search?startDate={start}-01-01&endDate={end}-12-31&compact=true&dateFieldName=auctionDate&format=jsonp&callback=jQuery36005594183916060127_1711782451828&filterscount=0&groupscount=2&group0=z3a&group1=t3a&pagenum=0&pagesize=500&recordstartindex=0&recordendindex=20&_=1711782452938'
        
        # 使用format方法替换占位符
        url = url_template.format(start=start_year, end=end_year)
        
        # 发起GET请求
        response = requests.get(url)
        
        conn = None
        
        # 检查请求是否成功
        if response.status_code == 200:
            # 请求成功，获取响应内容
            res_text = response.text
            
            # 去除JSONP回调函数和括号，只保留JSON部分
            json_part = res_text.strip()[len("jQuery36005594183916060127_1711782451828 ("):-2]
            
            # 使用正则表达式匹配所有的 e4:" 后面跟随的内容
            pattern = r'"e4":"(.*?)"'
            matches = re.findall(pattern, json_part)
            
            # 使用列表推导式给每个URL加上前缀
            prefix = "https://www.treasurydirect.gov/xml/"
            urls_to_add = [prefix + matche for matche in matches]
            
            # 连接数据库并创建表（如果不存在）
            conn = get_db_connection()
            cursor = conn.cursor()
            
            # 创建表（如果不存在）
            cursor.execute(f'''
                CREATE TABLE IF NOT EXISTS {TABLE}
                (url TEXT PRIMARY KEY)
            ''')
            conn.commit()
            
            # 读取现有的URL列表
            try:
                existing_urls = pd.read_sql_query(f"SELECT url FROM {TABLE}", conn)
                existing_urls_list = existing_urls['url'].tolist()
                print(f"从数据库读取到 {len(existing_urls_list)} 条URL记录")
            except Exception as e:
                print(f"读取数据库出错: {e}")
                existing_urls_list = []
            
            # 检查URL列中是否已存在这些url，创建一个去重后的列表
            unique_urls = list(set(urls_to_add) - set(existing_urls_list))
            print(f'找到 {len(unique_urls)} 条新URL')
            
            # 如果去重后的列表不为空，那么还有新的URL需要添加
            if unique_urls:
                # 将新的URL添加到数据库
                try:
                    for url in unique_urls:
                        cursor.execute(f"INSERT INTO {TABLE} (url) VALUES (?)", (url,))
                    conn.commit()
                    print(f"成功将 {len(unique_urls)} 条新URL添加到数据库中")
                except Exception as e:
                    print(f"插入数据库出错: {e}")
                    conn.rollback()
            else:
                print("所有URL都已存在于数据库中，无需添加。")
            
            # 第二步：处理XML数据
            if conn:
                print("\n第2步：处理XML数据并更新数据库")
                
                # 获取表的所有列
                table_columns = get_table_columns()
                
                # 获取需要处理的URL
                cursor = conn.cursor()
                cursor.execute(f"SELECT rowid, url FROM {TABLE} WHERE CUSIP IS NULL AND url IS NOT NULL")
                rows = cursor.fetchall()
                
                if not rows:
                    print("没有找到需要处理的URL")
                else:
                    print(f"找到 {len(rows)} 个需要处理的URL")
                    
                    # 逐个处理URL
                    processed_count = 0
                    for row_id, url in rows:
                        if process_and_update_row(conn, row_id, url, table_columns, config):
                            processed_count += 1
                    
                    print(f"成功处理 {processed_count}/{len(rows)} 个URL")
                    
                    # 处理日期字段
                    process_date_fields(conn, config)
        else:
            # 请求失败，打印错误信息
            print(f'Request failed with status code {response.status_code}')
        
        # 恢复标准输出并获取捕获的输出
        sys.stdout = old_stdout
        output = new_stdout.getvalue()
        
        # 关闭数据库连接
        if conn:
            conn.close()
        
        # 返回处理结果
        return jsonify({
            "message": "数据更新完成",
            "details": output,
            "success": True
        })
    
    except Exception as e:
        # 恢复标准输出
        if 'old_stdout' in locals():
            sys.stdout = old_stdout
        
        # 返回错误信息
        return jsonify({
            "message": f"数据更新失败: {str(e)}",
            "success": False
        })

# 添加从getNewXml.py复制的辅助函数
def fetch_xml_content(url, max_retries=3):
    """获取XML内容，带重试机制"""
    retries = 0
    while retries < max_retries:
        try:
            response = requests.get(url, timeout=30)
            response.raise_for_status()
            return response.content.decode('utf-8')
        except requests.exceptions.ConnectionError as e:
            retries += 1
            print(f"连接错误 (尝试 {retries}/{max_retries}): {url}")
            if retries < max_retries:
                print("等待 2 秒后重试...")
                time.sleep(2)
            else:
                print(f"达到最大重试次数，放弃: {e}")
                return None
        except Exception as e:
            print(f"获取URL时出错 {url}: {e}")
            return None

def parse_xml(xml_content):
    """解析XML内容"""
    if not xml_content:
        return {}
    
    data = {}
    try:
        root = ET.fromstring(xml_content)
        for element in root.iter():
            if element.text and element.text.strip():
                tag = element.tag.split('}')[-1]
                data[tag] = element.text.strip()
    except ET.ParseError as e:
        print(f"Error parsing XML: {e}")
    return data

def format_date_field(date, field_type):
    """格式化日期字段"""
    if pd.isna(date) or not isinstance(date, datetime):
        return ""
    
    week = date.isocalendar()[1]
    if field_type == 'week':
        return f"{date.year}年第{week:02d}周"
    return f"{date.year}年第{str(date.month).zfill(2)}月"

def process_and_update_row(conn, row_id, url, table_columns, config):
    """处理单个URL并更新数据库"""
    print(f"处理URL: {url}")
    
    # 获取并解析XML数据
    xml_content = fetch_xml_content(url)
    if not xml_content:
        print(f"无法获取URL内容: {url}")
        return False
    
    xml_data = parse_xml(xml_content)
    if not xml_data:
        print(f"无法解析XML内容: {url}")
        return False
    
    # 准备更新数据
    update_fields = []
    update_values = []
    
    # 将XML数据映射到表列
    for column in table_columns:
        if column in xml_data:
            update_fields.append(column)
            update_values.append(xml_data[column])
    
    if not update_fields:
        print(f"没有找到匹配的数据字段: {url}")
        return False
    
    # 构建更新SQL
    set_clause = ", ".join([f"{field} = ?" for field in update_fields])
    update_sql = f"UPDATE {config['table_name']} SET {set_clause} WHERE rowid = ?"
    update_values.append(row_id)
    
    # 执行更新
    cursor = conn.cursor()
    cursor.execute(update_sql, update_values)
    conn.commit()
    
    print(f"已更新 {cursor.rowcount} 行数据")
    return True

def process_date_fields(conn, config):
    """处理日期相关字段并更新数据库"""
    cursor = conn.cursor()
    
    # 获取所有需要处理的行
    cursor.execute(f"SELECT rowid, {', '.join(config['date_columns'])} FROM {config['table_name']} WHERE CUSIP IS NOT NULL")
    rows = cursor.fetchall()
    
    for row in rows:
        row_id = row[0]
        date_values = {}
        
        # 处理日期字段
        for i, col in enumerate(config['date_columns']):
            try:
                date_value = pd.to_datetime(row[i+1])
                date_values[col] = date_value
            except:
                date_values[col] = pd.to_datetime(config['default_date'])
        
        # 计算并更新日期相关字段
        updates = []
        params = []
        
        # 添加日期相关字段
        date_pairs = [('MaturityDate', '到期'), ('AuctionDate', '拍卖'), ('IssueDate', '发行')]
        for date_col, prefix in date_pairs:
            if date_col in date_values:
                updates.append(f'"{prefix}星期" = ?')
                params.append(format_date_field(date_values[date_col], 'week'))
                
                updates.append(f'"{prefix}月份" = ?')
                params.append(format_date_field(date_values[date_col], 'month'))
        
        # 计算久期
        if 'MaturityDate' in date_values and 'IssueDate' in date_values:
            duration_days = (date_values['MaturityDate'] - date_values['IssueDate']).days
            updates.append('"久期" = ?')
            params.append(duration_days)
            
            duration_months = int(round(duration_days / config['days_per_month']))
            updates.append('"久期(月数整数)" = ?')
            params.append(duration_months)
        
        # 执行更新
        if updates:
            update_sql = f"UPDATE {config['table_name']} SET {', '.join(updates)} WHERE rowid = ?"
            params.append(row_id)
            try:
                cursor.execute(update_sql, params)
            except sqlite3.Error as e:
                print(f"更新日期字段时出错 (行ID: {row_id}): {e}")
                print(f"SQL: {update_sql}")
                print(f"参数: {params}")
    
    conn.commit()
    print(f"已处理 {len(rows)} 行日期数据")

def fetch_data_with_date_range(order_by='url', ascending=False, limit=None, offset=None, date_field=None, years=None):
    """从数据库获取指定日期范围内的数据"""
    query = f"SELECT * FROM {TABLE}"
    
    # 如果指定了日期字段和年份范围，添加日期过滤条件
    params = None
    if date_field and years:
        # 计算日期范围
        end_date = datetime.now()
        start_date = end_date - timedelta(days=365 * years)
        
        # 调整到整月
        start_date = start_date.replace(day=1)
        
        # 转换为字符串格式
        start_date_str = start_date.strftime('%Y-%m-%d')
        end_date_str = end_date.strftime('%Y-%m-%d')
        
        query += f" WHERE {date_field} >= ? AND {date_field} <= ?"
        params = (start_date_str, end_date_str)
    
    # 添加排序
    query += f" ORDER BY {order_by} {'ASC' if ascending else 'DESC'}"
    
    # 添加分页
    if limit:
        query += f" LIMIT {limit}"
        if offset is not None:
            query += f" OFFSET {offset}"
    
    return execute_query(query, params=params)

def fetch_data_with_custom_date_range(date_field, start_date, end_date, order_by='url', ascending=False):
    """从数据库获取指定自定义日期范围内的数据"""
    query = f"SELECT * FROM {TABLE}"
    
    # 添加日期过滤条件
    params = None
    if date_field and start_date and end_date:
        query += f" WHERE {date_field} >= ? AND {date_field} <= ?"
        params = (start_date, end_date)
    
    # 添加排序
    query += f" ORDER BY {order_by} {'ASC' if ascending else 'DESC'}"
    
    return execute_query(query, params=params)

@app.route('/graphdata', methods=['GET', 'POST'])
def graphdata():
    """图表数据路由 - 支持预设年份范围和自定义日期范围"""
    columns = get_table_columns()
    
    # 默认参数
    x_field = '发行星期' if '发行星期' in columns else columns[0]
    date_field = 'AnnouncementDate' if 'AnnouncementDate' in columns else None
    years = 5  # 默认显示5年内的数据
    date_range_type = 'preset'  # 默认使用预设范围
    start_date = None
    end_date = None
    
    # 处理表单提交
    if request.method == 'POST':
        x_field = request.form.get('x_field', x_field)
        date_range_type = request.form.get('date_range_type', 'preset')
        
        if date_range_type == 'preset':
            # 处理预设年份范围
            years_str = request.form.get('years', str(years))
            try:
                years = int(years_str)
            except ValueError:
                years = 5
        else:
            # 处理自定义日期范围
            start_date = request.form.get('start_date')
            end_date = request.form.get('end_date')
    
    # 根据日期范围类型获取数据
    if date_field:
        if date_range_type == 'preset':
            # 使用预设年份范围
            df = fetch_data_with_date_range(date_field=date_field, years=years)
            title_suffix = f'最近{years}年数据'
        else:
            # 使用自定义日期范围
            if start_date and end_date:
                df = fetch_data_with_custom_date_range(date_field, start_date, end_date)
                title_suffix = f'{start_date} 至 {end_date}'
            else:
                # 如果自定义日期范围不完整，回退到默认范围
                df = fetch_data_with_date_range(date_field=date_field, years=years)
                title_suffix = f'最近{years}年数据'
    else:
        # 如果没有日期字段，则获取所有数据
        df = fetch_data()
        title_suffix = '全部数据'
    
    # 检查是否有数据
    if df.empty:
        return render_template(
            'graph.html',
            graph_html="<div class='alert alert-warning'>没有找到符合条件的数据</div>",
            x_field=x_field,
            columns=columns,
            years=years,
            date_range_type=date_range_type,
            start_date=start_date,
            end_date=end_date
        )
    
    # 创建数据透视表
    pivot_table = df.pivot_table(
        values='OfferingAmount', 
        index=x_field, 
        columns='久期(月数整数)', 
        aggfunc='sum', 
        fill_value=0
    )

    # 转换为适合Plotly的格式
    pivot_table = pivot_table.reset_index()
    df_melted = pivot_table.melt(
        id_vars=[x_field], 
        var_name='久期(月数整数)', 
        value_name='OfferingAmount'
    )

    # 计算每个x_field值的总和，用于后续计算移动平均线
    total_by_x = df_melted.groupby(x_field)['OfferingAmount'].sum().reset_index()
    
    # 计算移动平均线 MA5 和 MA10
    total_by_x['MA5'] = total_by_x['OfferingAmount'].rolling(window=5, min_periods=1).mean()
    total_by_x['MA10'] = total_by_x['OfferingAmount'].rolling(window=10, min_periods=1).mean()
    # 增加 MA20, MA60, MA120 移动平均线
    total_by_x['MA20'] = total_by_x['OfferingAmount'].rolling(window=20, min_periods=1).mean()
    total_by_x['MA60'] = total_by_x['OfferingAmount'].rolling(window=60, min_periods=1).mean()
    total_by_x['MA120'] = total_by_x['OfferingAmount'].rolling(window=120, min_periods=1).mean()

    # 生成堆积图
    fig = px.bar(
        df_melted, 
        x=x_field, 
        y='OfferingAmount', 
        color='久期(月数整数)', 
        barmode='stack', 
        title=f'堆积图 ({title_suffix})'
    )
    
    # 添加MA5移动平均线
    fig.add_scatter(
        x=total_by_x[x_field],
        y=total_by_x['MA5'],
        mode='lines',
        name='MA5',
        line=dict(color='red', width=2)
    )
    
    # 添加MA10移动平均线
    fig.add_scatter(
        x=total_by_x[x_field],
        y=total_by_x['MA10'],
        mode='lines',
        name='MA10',
        line=dict(color='blue', width=2)
    )
    
    # 添加MA20移动平均线
    fig.add_scatter(
        x=total_by_x[x_field],
        y=total_by_x['MA20'],
        mode='lines',
        name='MA20',
        line=dict(color='green', width=2)
    )
    
    # 添加MA60移动平均线
    fig.add_scatter(
        x=total_by_x[x_field],
        y=total_by_x['MA60'],
        mode='lines',
        name='MA60',
        line=dict(color='purple', width=2)
    )
    
    # 添加MA120移动平均线
    fig.add_scatter(
        x=total_by_x[x_field],
        y=total_by_x['MA120'],
        mode='lines',
        name='MA120',
        line=dict(color='orange', width=2)
    )
    
    # 更新图表布局，添加全屏按钮
    fig.update_layout(
        height=800,
        # 添加全屏按钮和其他配置
        modebar_add=['fullscreen', 'pan', 'zoom', 'select', 'lasso', 'zoomIn', 'zoomOut', 'autoScale', 'resetScale'],
        hovermode='closest'
    )

    return render_template(
        'graph.html', 
        graph_html=fig.to_html(full_html=True, include_plotlyjs=True, config={'displayModeBar': True, 'responsive': True}), 
        x_field=x_field, 
        columns=columns,
        years=years,
        date_range_type=date_range_type,
        start_date=start_date,
        end_date=end_date
    )

@app.route('/compare', methods=['GET', 'POST'])
def compare():
    """比较数据路由"""
    last_monday, last_friday, second_last_monday, second_last_friday = get_default_dates()
    
    if request.method == 'POST':
        # 获取表单数据
        group1_start_date = request.form.get('group1_start_date', str(last_monday))
        group1_end_date = request.form.get('group1_end_date', str(last_friday))
        group2_start_date = request.form.get('group2_start_date', str(second_last_monday))
        group2_end_date = request.form.get('group2_end_date', str(second_last_friday))
        date_field = request.form['date_field']

        # 获取并处理数据
        df = fetch_data()
        df[date_field] = pd.to_datetime(df[date_field])
        
        # 筛选两组数据
        group1 = df[(df[date_field] >= group1_start_date) & (df[date_field] <= group1_end_date)]
        group2 = df[(df[date_field] >= group2_start_date) & (df[date_field] <= group2_end_date)]

        # 汇总数据
        group1_summary = group1.groupby('久期(月数整数)').agg({'OfferingAmount': 'sum'}).reset_index()
        group1_summary['Group'] = 'Group 1'
        
        group2_summary = group2.groupby('久期(月数整数)').agg({'OfferingAmount': 'sum'}).reset_index()
        group2_summary['Group'] = 'Group 2'

        combined_summary = pd.concat([group1_summary, group2_summary])

        # 生成图表
        fig = px.bar(
            combined_summary, 
            x='Group', 
            y='OfferingAmount', 
            color='久期(月数整数)', 
            barmode='stack', 
            title="堆积柱状图"
        )
        fig.update_layout(xaxis_title='Group', yaxis_title='Offering Amount', barmode='stack')

        graph_html = fig.to_html(full_html=False)
        
        return render_template(
            'compare.html', 
            graph_html=graph_html,
            group1_start_date=group1_start_date, 
            group1_end_date=group1_end_date,
            group2_start_date=group2_start_date, 
            group2_end_date=group2_end_date
        )
    else:
        # GET请求返回默认值
        return render_template(
            'compare.html', 
            group1_start_date=last_monday, 
            group1_end_date=last_friday,
            group2_start_date=second_last_monday, 
            group2_end_date=second_last_friday,
            graph_html=""
        )
        
# 月内数据日度细节
@app.route('/get_data', methods=['POST'])
def get_data():
    """获取按日期汇总的数据"""
    req_data = request.json
    purpose = req_data['purpose']
    year = int(req_data['year'])
    month = int(req_data['month'])

    # 查询数据
    query = f"SELECT {purpose}, OfferingAmount FROM {TABLE} WHERE strftime('%Y', {purpose}) = ? AND strftime('%m', {purpose}) = ?"
    df = execute_query(query, params=(str(year), f'{month:02d}'))

    # 按日期汇总
    df[purpose] = pd.to_datetime(df[purpose])
    df = df.set_index(purpose)
    result = df.resample('D').sum()

    # 格式化返回数据
    labels = result.index.strftime('%Y-%m-%d').tolist()
    values = result['OfferingAmount'].fillna(0).tolist()

    return jsonify(labels=labels, values=values)

@app.route('/delete-record/<int:record_id>', methods=['POST'])
def delete_record(record_id):
    """删除指定ID的记录"""
    try:
        # 获取所有数据
        all_data = fetch_data()
        
        # 检查记录ID是否有效
        if record_id < 1 or record_id > len(all_data):
            return jsonify({"success": False, "message": "无效的记录ID"})
        
        # 获取要删除的记录的行索引（从0开始）
        row_index = record_id - 1
        
        # 获取该行的唯一标识符（假设第一列是主键）
        primary_key_column = all_data.columns[0]
        primary_key_value = all_data.iloc[row_index][primary_key_column]
        
        # 执行删除操作
        query = f"DELETE FROM {TABLE} WHERE {primary_key_column} = ?"
        affected_rows = execute_update(query, params=(primary_key_value,))
        
        if affected_rows > 0:
            return jsonify({"success": True, "message": "记录删除成功"})
        else:
            return jsonify({"success": False, "message": "未找到要删除的记录"})
    
    except Exception as e:
        return jsonify({"success": False, "message": f"删除失败: {str(e)}"})

if __name__ == '__main__':
    app.run(debug=True)

# 进入项目目录：cd C:\zencode\usdebt\server
# 创建虚拟环境：python -m venv myenv
# 启动虚拟环境：myenv\Scripts\activate
# 启动服务：python app.py