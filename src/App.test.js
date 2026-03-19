import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import App from './App';

describe('App', () => {
  test('renders batch dashboard and import action', () => {
    render(
      <MemoryRouter>
        <App />
      </MemoryRouter>
    );

    expect(
      screen.getByRole('heading', { name: /batch/i })
    ).toBeInTheDocument();

    expect(
      screen.getByText(/edit up to 250 images at once/i)
    ).toBeInTheDocument();

    expect(
      screen.getByText(/import images/i)
    ).toBeInTheDocument();
  });
});
