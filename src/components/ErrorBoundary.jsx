import React from 'react';

class ErrorBoundary extends React.Component {
  constructor(props) {
    super(props);
    this.state = { hasError: false, error: null };
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error };
  }

  componentDidCatch(error, info) {
    console.error('ErrorBoundary yakaladı:', error, info);
  }

  render() {
    if (this.state.hasError) {
      return (
        <div style={{
          display: 'flex', flexDirection: 'column', alignItems: 'center',
          justifyContent: 'center', height: '100%', background: '#1e1e1e',
          color: '#f48771', padding: '32px', textAlign: 'center',
        }}>
          <div style={{ fontSize: 32, marginBottom: 16 }}>⚠</div>
          <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
            {this.props.label || 'Bir hata oluştu'}
          </div>
          <div style={{ fontSize: 12, color: '#858585', marginBottom: 20, maxWidth: 400 }}>
            {this.state.error?.message}
          </div>
          <button
            onClick={() => this.setState({ hasError: false, error: null })}
            style={{
              background: '#0e639c', color: '#fff', border: 'none',
              padding: '6px 18px', borderRadius: 4, cursor: 'pointer', fontSize: 13,
            }}
          >
            Yeniden Dene
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}

export default ErrorBoundary;
