import React from 'react';
import { X } from 'lucide-react';
import './TabBar.css';

const TabBar = ({ tabs, activeTab, onTabClick, onTabClose }) => {
  if (!tabs || tabs.length === 0) return null;

  return (
    <div className="tab-bar">
      {tabs.map((tab) => (
        <div
          key={tab.name}
          className={`tab ${activeTab === tab.name ? 'active' : ''} ${tab.modified ? 'modified' : ''}`}
          onClick={() => onTabClick(tab)}
          title={tab.name}
        >
          <span className="tab-name">{tab.name}</span>
          {tab.modified && <span className="tab-dot">●</span>}
          <button
            className="tab-close"
            onClick={(e) => { e.stopPropagation(); onTabClose(tab); }}
            title="Kapat"
          >
            <X size={12} />
          </button>
        </div>
      ))}
    </div>
  );
};

export default TabBar;
